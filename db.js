const { s3, HeadBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('./awsS3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const bucketName = 'aws-testing-prolerus';

// License Key Management System (in-memory)
// Defines maximum number of accounts per license key
// Structure: { "licenseKey": maxAccounts }
const licenseKeyLimits = {
    "BurnsideHighSchool": 4,  // Example school license
    "MP003": 8,               // Example license
    "3399": 20,               // Example license
    "STUDENT_KEY_1": 10,       // Default student license
    "TEACHER_KEY_2": 10,      // Default teacher license
    // Add more license keys and their limits as needed
};

// Valid License Keys by Account Type
// Defines which license keys are valid for each account type
// Structure: { accountType: ["licenseKey1", "licenseKey2"] }
const validLicenseKeys = {
    student: ["STUDENT_KEY_1", "STUDENT_KEY_2"], // Valid student license keys
    teacher: ["TEACHER_KEY_1", "TEACHER_KEY_2"]  // Valid teacher license keys
};

/**
 * Verifies connection to S3 bucket
 * @returns {Promise<boolean>} True if connection successful
 * @throws {Error} If connection fails
 */
async function connectToDatabase() {
    try {
        // Verify S3 connectivity
        const command = new HeadBucketCommand({ Bucket: bucketName });
        await s3.send(command);
        console.log('Connected successfully to S3 bucket');
        return true;
    } catch (error) {
        console.error('Error connecting to S3:', error);
        throw error;
    }
}

/**
 * Creates a new user in the database
 * @param {Object} userData - User information including email, licenseKey, and accountType
 * @returns {Promise<Object>} Created user data
 * @throws {Error} If user creation fails
 */
async function createUser(userData) {
    try {
        // Validate email uniqueness
        const getExistingUserCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: `users/${userData.email}.json`
        });
        const existingUser = await s3.send(getExistingUserCommand).catch(() => null);

        if (existingUser) {
            throw new Error('Email already in use');
        }

        // Validate license key for account type
        if (!validLicenseKeys[userData.accountType].includes(userData.licenseKey)) {
            throw new Error('Invalid license key for the selected account type.');
        }

        // Check license key usage limits
        const users = await listUsers();
        const licenseKeyCount = users.filter(u => u.licenseKey === userData.licenseKey).length;
        const licenseKeyLimit = licenseKeyLimits[userData.licenseKey] || 0;

        if (licenseKeyCount >= licenseKeyLimit) {
            throw new Error('License key limit reached. No more accounts can be registered with this key.');
        }

        // Store user in S3
        const putUserCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: `users/${userData.email}.json`,
            Body: JSON.stringify(userData),
            ContentType: 'application/json'
        });
        await s3.send(putUserCommand);

        console.log("User successfully registered:", userData);
        return userData;
    } catch (error) {
        console.error("Error during user registration:", error);
        throw new Error('Failed to register user');
    }
}

async function listUsers() {
    try {
        const command = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: 'users/'
        });
        const data = await s3.send(command);

        // Handle case where no users exist yet
        if (!data.Contents || data.Contents.length === 0) {
            return [];
        }

        const users = await Promise.all(data.Contents.map(async (item) => {
            const getUserCommand = new GetObjectCommand({
                Bucket: bucketName,
                Key: item.Key
            });
            const userData = await s3.send(getUserCommand);
            
            // Convert the ReadableStream to string and parse JSON
            const chunks = [];
            for await (const chunk of userData.Body) {
                chunks.push(chunk);
            }
            const userString = Buffer.concat(chunks).toString('utf8');
            const user = JSON.parse(userString);
            
            // Validate required fields
            if (!user.email || !user.firstName || !user.accountType) {
                throw new Error('Invalid user data format');
            }
            
            return user;
        }));

        return users;
    } catch (error) {
        console.error('Error listing users:', error);
        throw error;
    }
}

/**
 * Retrieves user information and associated videos
 * @param {string} email - User's email address
 * @returns {Promise<Object>} Object containing user data and associated videos
 * @throws {Error} If user is not found
 */
async function readUser(email) {
    try {
        // Get user data
        const getUserCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: `users/${email}.json`
        });
        const userData = await s3.send(getUserCommand);
        
        // Convert the ReadableStream to string and parse JSON
        const chunks = [];
        for await (const chunk of userData.Body) {
            chunks.push(chunk);
        }
        const userString = Buffer.concat(chunks).toString('utf8');
        
        // Parse JSON and ensure required fields exist
        const user = JSON.parse(userString);
        if (!user.email || !user.firstName || !user.accountType) {
            throw new Error('Invalid user data format');
        }

        // Get user's videos
        const videos = await listVideos(
            user.email, 
            user.accountType, 
            user.schoolName, 
            user.classCodesArray
        );

        return { user, videos };
    } catch (error) {
        console.error('Error reading user:', error);
        throw new Error('User not found');
    }
}

async function listVideos(userEmail, accountType, schoolName, classCodes = []) {
    try {
        if (!accountType || !['student', 'teacher'].includes(accountType)) {
            throw new Error('Invalid account type');
        }

        let videos = [];
        const metadataPrefix = accountType === 'teacher' 
            ? `videos/${schoolName}/` 
            : `videos/${schoolName}/${userEmail}/`;

        // Get metadata files
        const metadataCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: metadataPrefix
        });
        const metadataResult = await s3.send(metadataCommand);

        if (metadataResult.Contents) {
            videos = await Promise.all(metadataResult.Contents.map(async (item) => {
                if (!item.Key.endsWith('.json')) return null;

                const getMetadataCommand = new GetObjectCommand({
                    Bucket: bucketName,
                    Key: item.Key
                });
                const metadataResponse = await s3.send(getMetadataCommand);
                
                // Convert the ReadableStream to string and parse JSON
                const chunks = [];
                for await (const chunk of metadataResponse.Body) {
                    chunks.push(chunk);
                }
                const metadataString = Buffer.concat(chunks).toString('utf8');
                
                try {
                    const metadata = JSON.parse(metadataString);
                    if (!metadata || typeof metadata !== 'object') {
                        throw new Error('Invalid metadata format');
                    }

                    // For teachers, filter by school name and class codes
                    if (accountType === 'teacher') {
                        if (metadata.schoolName !== schoolName || 
                            !classCodes.includes(metadata.classCode)) {
                            return null;
                        }
                    }

                    // Verify both metadata and video files exist
                    const videoKey = metadata.videoPath;
                    
                    try {
                        // Verify metadata file exists
                        await s3.send(new HeadObjectCommand({
                            Bucket: bucketName,
                            Key: item.Key // The metadata JSON file
                        }));

                        // Verify video file exists
                        await s3.send(new HeadObjectCommand({
                            Bucket: bucketName,
                            Key: videoKey
                        }));

                        // Generate signed URL for video access
                        const videoUrl = await getSignedUrl(s3, new GetObjectCommand({
                            Bucket: bucketName,
                            Key: videoKey,
                            ResponseContentType: metadata.contentType || 'video/mp4',
                            Expires: 3600 // URL valid for 1 hour
                        }));
                        console.log('Generated video URL:', videoUrl);

                        return {
                            ...metadata,
                            videoUrl,
                            videoKey,
                            mimeType: metadata.contentType || 'video/mp4',
                            metadataKey: item.Key
                        };
                    } catch (error) {
                        console.error('File verification failed:', {
                            metadataKey: item.Key,
                            videoKey: videoKey,
                            error: error.message
                        });
                        return null; // Skip this video if either file is missing
                    }
                } catch (error) {
                    console.error('Error parsing video metadata:', error);
                    return null;
                }
            }));

            // Filter out null values
            videos = videos.filter(v => v !== null);
        }

        return videos;
    } catch (error) {
        console.error('Error listing videos:', error);
        return [];
    }
}

/**
 * Updates user's class codes by adding or removing a code
 * @param {string} email - User's email address
 * @param {Object} options - Contains classCode to add/remove
 * @param {string} action - 'add' or 'delete' operation
 * @returns {Promise<Object>} Success message
 * @throws {Error} If user not found or operation fails
 */
async function updateUser(email, { classCode }, action) {
    try {
        // Get existing user data
        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: `users/${email}.json`
        });
        const userData = await s3.send(command);
        
        const user = JSON.parse(userData.Body.toString());

        if (action === 'add') {
            // Add new class code
            if (!user.classCodesArray) {
                user.classCodesArray = [];
            }
            user.classCodesArray.push(classCode);
        } else if (action === 'delete') {
            // Remove class code
            if (!user.classCodesArray.includes(classCode)) {
                throw new Error('Class code does not exist');
            }
            user.classCodesArray = user.classCodesArray.filter(code => code !== classCode);
        } else {
            throw new Error('Invalid action. Use "add" or "delete".');
        }

        // Save updated user data
        const putUserCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: `users/${email}.json`,
            Body: JSON.stringify(user),
            ContentType: 'application/json'
        });
        await s3.send(putUserCommand);

        return { message: `Class code ${action === 'add' ? 'added' : 'deleted'} successfully!` };
    } catch (error) {
        console.error('Error updating user:', error);
        throw error;
    }
}

/**
 * Deletes a user and optionally their associated videos
 * @param {string} email - User's email address
 * @returns {Promise<Object>} Delete operation result
 * @throws {Error} If user is not found
 */
async function deleteUser(email) {
    try {
        // Delete user file
        const command = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: `users/${email}.json`
        });
        await s3.send(command);

        // Delete user's videos
        const videos = await listVideos(email);
        await Promise.all(videos.map(async (video) => {
            const deleteVideoCommand = new DeleteObjectCommand({
                Bucket: bucketName,
                Key: `videos/${email}/${video.fileId}`
            });
            await s3.send(deleteVideoCommand);
        }));

        return { deleted: true };
    } catch (error) {
        console.error('Error deleting user:', error);
        throw error;
    }
}

/**
 * Uploads a video to S3 storage with associated metadata
 * @param {Object} videoData - Video information including buffer, metadata, and user details
 * @returns {Promise<Object>} Upload result containing file ID and metadata
 * @throws {Error} If upload fails
 */
async function uploadVideo(videoData) {
    try {
        console.log('Uploading video to S3...');

        // Create structured path based on user type
        let videoPath;
        if (videoData.accountType === 'student') {
            videoPath = `videos/${videoData.schoolName}/${videoData.classCode}/${videoData.userEmail}/${videoData.title}`;
        } 

        // Create metadata file
        const metadata = {
            title: videoData.title,
            subject: videoData.subject,
            userId: videoData.userId,
            userEmail: videoData.userEmail,
            classCode: videoData.classCode,
            contentType: videoData.mimetype,
            viewed: false,
            schoolName: videoData.schoolName,
            accountType: videoData.accountType,
            videoPath: `${videoPath}.mp4`
        };

        // Upload metadata
        const metadataParams = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `${videoPath}.json`,
            Body: JSON.stringify(metadata),
            ContentType: 'application/json'
        };
        await s3.send(new PutObjectCommand(metadataParams));

        // Upload video file
        const videoParams = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `${videoPath}.mp4`,
            Body: videoData.buffer,
            ContentType: videoData.mimetype
        };

        // Upload both metadata and video
        const metadataResponse = await s3.send(new PutObjectCommand(metadataParams));
        const videoResponse = await s3.send(new PutObjectCommand(videoParams));
        console.log('Video and metadata uploaded successfully to S3');

        return {
            fileId: videoResponse.Key,
            filename: videoResponse.Key,
            metadata: metadata
        };
    } catch (error) {
        console.error('Error uploading video:', error);
        throw new Error('Failed to upload video: ' + error.message);
    }
}

module.exports = { 
    connectToDatabase, 
    createUser, 
    readUser, 
    updateUser, 
    deleteUser, 
    uploadVideo,
    listVideos 
};
