// Server Configuration and Initialization
require('dotenv').config(); // Load environment variables from .env file
const express = require('express'); // Express framework for handling HTTP requests
const { 
    sendPasswordResetEmail, 
    generateResetToken, 
    storeResetToken, 
    validateResetToken, 
    deleteResetToken 
} = require('./emailService'); // Email service functions for password reset
const multer = require('multer'); // Middleware for handling file uploads

// Database and S3 related imports
const { 
    createUser,
    readUser,
    updateUser,
    deleteUser,
    uploadVideo,
    listVideos
} = require('./db');
const { s3, bucketName, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('./awsS3');
const path = require('path'); // Path module for file path operations
const cors = require('cors'); // CORS middleware for cross-origin requests

// Initialize Express application
const app = express(); 
const port = process.env.PORT || 4000;

// Security modules
const bcrypt = require('bcrypt'); // For password hashing

// Application Configuration
const validSchoolNames = ["Burnside", "STAC", "School C"]; // List of valid school names
const validLicenseKeys = ["BurnsideHighSchool", "MP003", "3399", "STUDENT_KEY_1", "TEACHER_KEY_2"]; // Valid license keys

// Middleware Configuration
app.use(express.json()); // Parse JSON request bodies
app.use(cors()); // Enable CORS for all routes

// Global error handler middleware
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    res.status(500).json({ 
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Verify S3 connection
async function verifyStorageConnection() {
    try {
        const command = new ListObjectsV2Command({ Bucket: bucketName });
        await s3.send(command);
        console.log('S3 connection verified');
    } catch (error) {
        console.error('S3 connection failed:', error);
        process.exit(1);
    }
}

// Verify storage connection on startup
verifyStorageConnection();
// File Upload Configuration
const upload = multer({
    storage: multer.memoryStorage(), // Store files in memory
    limits: {
        fileSize: 5 * 1024 * 1024 * 1024, // 5GB file size limit
        fieldSize: 5 * 1024 * 1024 * 1024 // 5GB field size limit
    },
    fileFilter: (req, file, cb) => {
        // Validate file type - only allow video files
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'), false);
        }
    }
});

/**
 * Retrieves user information including first name, class codes, and school name
 * @param {string} email - User's email address (query parameter)
 * @returns {Object} JSON response with user information
 */
app.get('/user-info', async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const { user } = await readUser(email);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Capitalize first name for display
        const capitalizedFirstName = user.firstName.charAt(0).toUpperCase() + user.firstName.slice(1);
        
        res.json({
            firstName: capitalizedFirstName,
            classCodes: user.classCodesArray,
            schoolName: user.schoolName
        });
    } catch (error) {
        console.error('Error fetching user info:', error);
        res.status(500).json({ message: 'Failed to fetch user info' });
    }
});

/**
 * Handles video uploads to GridFS storage
 * @param {Object} req.file - Uploaded video file
 * @param {Object} req.body - Video metadata
 * @returns {Object} JSON response with upload status
 */
app.post('/upload', upload.single('video'), async (req, res) => {
    console.log('Upload request received');
    console.log('Request body:', req.body);
    console.log('Uploaded file:', req.file);

    if (!req.file) {
        console.log('No file uploaded');
        return res.status(400).json({ message: 'No video file uploaded' });
    }

    try {
        console.log('Connecting to database...');
        const { user } = await readUser(req.body.email);
        if (!user) {
            console.log('User not found');
            return res.status(404).json({ message: 'User not found' });
        }

        // Validate user object
        if (!user) {
            console.log('Invalid user object:', user);
            return res.status(400).json({ message: 'Invalid user data' });
        }

        // Prepare video data for storage
        const videoData = {
            title: req.body.title,
            subject: req.body.subject,
            userId: user.email, // Using email as the unique identifier
            userEmail: user.email,
            classCode: req.body.classCode,
            accountType: user.accountType,
            schoolName: user.schoolName,
            buffer: req.file.buffer,
            filename: `${Date.now()}_${req.file.originalname}`,
            mimetype: req.file.mimetype,
            studentName: user.firstName
        };

        // Check for existing video with same metadata
        const videos = await listVideos(user.email);
        const existingVideo = videos.find(video => 
            video.title === req.body.title && 
            video.classCode === req.body.classCode
        );

        if (existingVideo) {
            return res.status(400).json({ message: 'A video with the same title and class code already exists' });
        }

        console.log('Video data:', videoData);

        // Upload video to S3
        const uploadResult = await uploadVideo(videoData);
        console.log('Video uploaded successfully:', uploadResult);
        

        // Redirect back to upload page after successful upload
        res.redirect('/upload-.html');
    } catch (error) {
        console.error('Video upload error:', error);
        res.status(500).json({ 
            message: 'Failed to upload video',
            error: error.message 
        });
    }
});

// Serve static files from the current directory
app.use(express.static(__dirname));

/**
 * Handles user registration with validation and account creation
 * @param {Object} req.body - Registration data including license key, school name, etc.
 * @returns {Object} JSON response with registration status
 */
app.post('/register', async (req, res) => {
    console.log("Registration request received:", req.body);
    console.log("Valid license keys:", validLicenseKeys);
    const { licenseKey, schoolName, firstName, email, password, classCodes, accountType } = req.body;
    console.log("License key received:", licenseKey);

    if (validLicenseKeys.includes(licenseKey)) {
        // Validate school name
        if (!validSchoolNames.includes(schoolName)) {
            return res.status(400).json({ message: "Invalid school name." });
        }
        
        // Process class codes
        const classCodesArray = classCodes.split(',').map(code => code.trim());
        console.log("Password received:", password);
        
        // Hash password for secure storage
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create new user object
        const newUser = {
            firstName,
            email,
            password: hashedPassword,
            classCodesArray,
            licenseKey,
            accountType,
            schoolName
        };

        // Create user in S3
        try {
            await createUser(newUser);
            res.status(200).json({ message: "Registration successful!", email });
        } catch (error) {
            console.error("Error during user registration:", error.message);
            res.status(400).json({ message: error.message });
        }
    } else {
        res.status(400).json({ message: "Invalid license key" });
    }
});

/**
 * Retrieves class codes associated with a user
 * @param {string} email - User's email address (query parameter)
 * @returns {Array} JSON array of class codes
 */
app.get('/class-codes', async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const { user } = await readUser(email);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Return user's class codes
        res.status(200).json(user.classCodesArray);
    } catch (error) {
        console.error('Error fetching class codes:', error);
        res.status(500).json({ message: 'Failed to fetch class codes' });
    }
});

/**
 * Handles user authentication and session initiation
 * @param {string} email - User's email address
 * @param {string} password - User's password
 * @returns {Object} JSON response with authentication status and redirect information
 */
app.post('/sign-in', async (req, res) => {
    const { email, password } = req.body;
    console.log("Sign-in request received:", req.body);

    try {
        const { user } = await readUser(email);
        if (!user) {
            return res.status(400).json({ message: "Invalid email or password" });
        }

        // Validate password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).json({ message: "Invalid email or password" });
        }

        // Determine redirect page based on account type
        const redirectPage = user.accountType === 'teacher' ? 'teacher-.html' : 'student-.html';
        res.status(200).json({ 
            message: "Sign-in successful!", 
            redirectPage, 
            user: { 
                email: user.email, 
                firstName: user.firstName, 
                accountType: user.accountType 
            } 
        });
    } catch (error) {
        console.error("Error during sign-in:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

app.delete('/delete-account', async (req, res) => {
    const email = req.query.email; // Get the email from the query parameter
    console.log('Delete account request received for email:', email); // Log the email

    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        // Delete user and associated videos
        await deleteUser(email);

        console.log('Account deleted successfully for email:', email);
        res.status(200).json({ message: 'Account deleted successfully' });
    } catch (error) {
        console.error('Error deleting account:', error);
        res.status(500).json({ message: 'Failed to delete account' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'sign-in.html')); // Serve sign-in.html
});

app.get('/videos/:key', async (req, res) => {
    const videoKey = req.params.key;
    console.log('Attempting to retrieve video from S3 with key:', videoKey);
    
    try {
        const s3 = require('./awsS3');
        const params = {
            Bucket: 'aws-testing-prolerus',
            Key: videoKey
        };

        const videoStream = s3.getObject(params).createReadStream();
        
        videoStream.on('error', (error) => {
            console.error('Error streaming video:', error);
            res.status(404).json({ message: 'Video not found' });
        });

        // Set appropriate content type
        res.set('Content-Type', 'video/mp4');
        videoStream.pipe(res);
    } catch (error) {
        console.error('Error retrieving video:', error);
        res.status(500).json({ message: 'Failed to retrieve video' });
    }
});

    
app.get('/videos', async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const { user } = await readUser(email);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const videos = await listVideos(
            user.email,
            user.accountType,
            user.schoolName,
            user.classCodesArray
        );

        // Format response based on account type
        const formattedVideos = videos.map(video => ({
            id: video.videoKey,
            title: video.title,
            subject: video.subject,
            classCode: video.classCode,
            url: video.videoUrl,
            viewed: video.viewed,
            studentName: video.studentName || user.firstName
        }));

        res.status(200).json(formattedVideos);
    } catch (error) {
        console.error('Error fetching videos:', error);
        res.status(500).json({ message: 'Failed to fetch videos' });
    }
});

app.delete('/delete-video', async (req, res) => {
    const videoId = req.query.id; // Get the video ID from the query parameter
    console.log('Delete request received for video ID:', videoId); // Log the video ID

    if (!videoId) {
        return res.status(400).json({ message: 'Video ID is required' });
    }

    try {
        const { s3, DeleteObjectCommand } = require('./awsS3');
        const command = new DeleteObjectCommand({
            Bucket: 'aws-testing-prolerus',
            Key: videoId
        });
        await s3.send(command);

        console.log('Video deleted successfully:', videoId);
        res.status(200).json({ message: 'Video deleted successfully' });
    } catch (error) {
        console.error('Error deleting video:', error);
        res.status(500).json({ message: 'Failed to delete video' });
    }
});

app.post('/videos/view', async (req, res) => {
    const videoId = req.body.id; // Get the video ID from the request body
    console.log('Mark as viewed request received for video ID:', videoId); // Log the video ID

    if (!videoId) {
        return res.status(400).json({ message: 'Video ID is required' });
    }

    try {
        const { s3, CopyObjectCommand } = require('./awsS3');
        const command = new CopyObjectCommand({
            Bucket: 'aws-testing-prolerus',
            CopySource: `aws-testing-prolerus/${videoId}`,
            Key: videoId,
            Metadata: {
                viewed: 'true'
            },
            MetadataDirective: 'REPLACE'
        });
        await s3.send(command);

        console.log('Video marked as viewed successfully:', videoId);
        res.status(200).json({ message: 'Video marked as viewed successfully' });
    } catch (error) {
        console.error('Error marking video as viewed:', error);
        res.status(500).json({ message: 'Failed to mark video as viewed' });
    }
});

// Password Reset Request Endpoint
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;

    try {
        const { user } = await readUser(email);
        
        // For security, don't reveal if email exists or not
        if (!user) {
            // Still return success to prevent email enumeration
            return res.status(200).send('If your email exists in our system, you will receive a password reset link.');
        }

        // Generate and store reset token
        const token = generateResetToken();
        storeResetToken(email, token);

        // Log the reset link (for development/testing)
        console.log('Password reset link:', `http://localhost:3000/reset-password.html?token=${token}`);

        // In production, this would send an actual email
        await sendPasswordResetEmail(email, token);

        res.status(200).send('If your email exists in our system, you will receive a password reset link.');
    } catch (error) {
        console.error('Error processing password reset request:', error);
        // Generic error message for security
        return res.status(500).send('An error occurred. Please try again later.');
    }
});

// Password Reset Endpoint
app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    try {
        // Validate the reset token
        const email = validateResetToken(token);
        if (!email) {
            return res.status(400).send('This password reset link has expired or is invalid. Please request a new one.');
        }

        // Hash the new password and update it in the database
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await updateUser(email, { password: hashedPassword });

        // Delete the used token
        deleteResetToken(token);

        res.status(200).send('Your password has been reset successfully. You can now log in with your new password.');
    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).send('An error occurred while resetting your password. Please try again.');
    }
});

app.put('/update-user', async (req, res) => {
    const email = req.body.email; // Get the email from the request body
    const { classCode } = req.body; // Get the class code from the request body
    const action = req.body.action; // Get the action (add or delete)

    if (!email || !classCode || !action) {
        return res.status(400).json({ message: 'Email, class code, and action are required' });
    }

    try {
        const { user } = await readUser(email);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Update the user's class codes
        await updateUser(email, { classCode }, action);
        res.status(200).json({ message: `Class code ${action === 'add' ? 'added' : 'deleted'} successfully!` });
    } catch (error) {
        console.error('Error updating user class codes:', error);
        res.status(500).json({ message: 'Code invalid' });
    }
});
app.listen(port, () => {console.log(`Listening on port ${port}`);});
