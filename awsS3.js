const AWS = require('aws-sdk');

// Configure AWS with your access and secret key.
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION // e.g., 'us-east-1'
});

// Create S3 service object
const s3 = new AWS.S3();

module.exports = s3;
