const { s3, HeadBucketCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('./awsS3');
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
        const videos = await listVideos(user.email);

        return { user, videos };
    } catch (error) {
        console.error('Error reading user:', error);
        throw new Error('User not found');
    }
}

async function listVideos(userEmail) {
    try {
        const listVideosCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: `videos/${userEmail}/`
        });
        const data = await s3.send(listVideosCommand);

        // Handle case where no videos exist yet
        if (!data.Contents || data.Contents.length === 0) {
            return [];
        }

        const videos = await Promise.all(data.Contents.map(async (item) => {
            const getVideoCommand = new GetObjectCommand({
                Bucket: bucketName,
                Key: item.Key
            });
            const videoData = await s3.send(getVideoCommand);
            
            // Convert the ReadableStream to string and parse JSON
            const chunks = [];
            for await (const chunk of videoData.Body) {
                chunks.push(chunk);
            }
            const videoString = Buffer.concat(chunks).toString('utf8');
            return JSON.parse(videoString);
        }));

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

        const params = {
            Bucket: process.env.S3_BUCKET_NAME, // Your S3 bucket name
            Key: `${videoData.userId}/${videoData.title}`, // File name you want to save as in S3
            Body: videoData.buffer, // The video buffer
            ContentType: videoData.mimetype // MIME type of the video
        };

        // Uploading files to the bucket
        const command = new PutObjectCommand(params);
        const s3Response = await s3.send(command);
        console.log('Video uploaded successfully to S3:', s3Response.Location);

        return {
            fileId: s3Response.Key,
            filename: s3Response.Key,
            metadata: {
                title: videoData.title,
                subject: videoData.subject,
                userId: videoData.userId,
                userEmail: videoData.userEmail,
                classCode: videoData.classCode,
                contentType: videoData.mimetype,
                viewed: false,
                schoolName: videoData.schoolName
            }
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
