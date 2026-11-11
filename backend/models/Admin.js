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
    },
    passwordChangedAt: Date,
    // Authenticator-app sign-in. The secret is encrypted (services/adminSecurity),
    // recovery codes are stored only as keyed hashes, and lastStep stops a code
    // from being used twice.
    twoFactor: {
        secret: String,
        enabledAt: Date,
        lastStep: { type: Number, default: -1 },
        recoveryCodes: { type: [String], default: undefined },
    },
    // A secret being set up, kept until it is confirmed with a code.
    pendingTwoFactor: {
        secret: String,
        createdAt: Date,
    },
}, { timestamps: true });

// Usernames: 3–64 ASCII letters, digits and . _ @ - (no spaces or look-alike characters).
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/;
adminSchema.statics.normalizeUsername = function (value) {
    if (typeof value !== 'string') return null;
    const username = value.trim();
    return USERNAME_PATTERN.test(username) ? username : null;
};

// bcrypt work factor. Hashes made with a lower one are upgraded at the next sign-in.
const BCRYPT_COST = 12;
adminSchema.statics.BCRYPT_COST = BCRYPT_COST;
adminSchema.methods.needsRehash = function () {
    try { return bcrypt.getRounds(this.password) < BCRYPT_COST; } catch { return false; }
};

// Hash password before saving
adminSchema.pre('save', async function () {
    if (!this.isModified('password')) return;

    const salt = await bcrypt.genSalt(BCRYPT_COST);
    this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare passwords
adminSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
