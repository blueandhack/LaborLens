const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    // Raised on every username or password change; sign-in tokens carry the
    // version they were issued under, so older tokens stop working.
    tokenVersion: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

// Usernames: 3–64 ASCII letters, digits and . _ @ - (no spaces or look-alike characters).
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/;
adminSchema.statics.normalizeUsername = function (value) {
    if (typeof value !== 'string') return null;
    const username = value.trim();
    return USERNAME_PATTERN.test(username) ? username : null;
};

// Hash password before saving
adminSchema.pre('save', async function () {
    if (!this.isModified('password')) return;

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare passwords
adminSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
