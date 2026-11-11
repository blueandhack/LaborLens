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
app.get('/api/health', (_req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ ready: mongoose.connection.readyState === 1 }));

// Routes
app.use('/api/upload', uploadRoute);
app.use('/api/search', searchRoute);
app.use('/api/cases', caseRoute);
const employers = require('./routes/employers').createEmployerRoutes({ db: () => mongoose.connection.db, models: require('./models/programModels') });
app.use('/api/employers', employers.api);
app.use('/employers', employers.pages);
app.use('/api/map', require('./routes/map').createMapRoutes({ db: () => mongoose.connection.db }));
app.use('/api/i140', require('./routes/i140').createI140Routes({ db: () => mongoose.connection.db }));
app.use('/api/uscis-h1b', require('./routes/uscis').createUscisRoutes({ db: () => mongoose.connection.db, authMiddleware: require('./routes/admin').authMiddleware }));
app.use('/api/admin', adminRoute);

// MongoDB connection
mongoose.connect(MONGO_URI, { autoIndex: process.env.NODE_ENV !== 'production', maxPoolSize: 8,
    minPoolSize: 0, maxIdleTimeMS: 60000, waitQueueTimeoutMS: 5000, serverSelectionTimeoutMS: 10000 })
    .then(async () => {
        console.log('Connected to MongoDB');
        // The USCIS approvals page's unfiltered totals take seconds to add up; build them before visitors ask.
        require('./services/uscisH1b').warmUscisCache(() => mongoose.connection.db);
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
