require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const uploadRoute = require('./routes/upload');
const { router: searchRoute, invalidateCache } = require('./routes/search');
const caseRoute = require('./routes/cases');
const { router: adminRoute } = require('./routes/admin');
const Admin = require('./models/Admin');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/pwd_cases';

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/upload', uploadRoute);
app.use('/api/search', searchRoute);
app.use('/api/cases', caseRoute);
app.use('/api/admin', adminRoute);

// MongoDB connection
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('Connected to MongoDB');
        // Seed default admin if none exists
        try {
            const adminCount = await Admin.countDocuments();
            if (adminCount === 0) {
                const initPassword = process.env.ADMIN_INIT_PASSWORD;
                if (!initPassword) {
                    console.warn('No admin exists and ADMIN_INIT_PASSWORD is not set. Set this env var to create the initial admin.');
                } else {
                    const defaultAdmin = new Admin({ username: 'admin', password: initPassword });
                    await defaultAdmin.save();
                    console.log('Default admin user created from ADMIN_INIT_PASSWORD');
                }
            }
        } catch (error) {
            console.error('Error seeding admin user:', error);
        }
    })
    .catch(err => console.error('MongoDB connection error:', err));

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
