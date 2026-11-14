// Shared HTTP boundary policy. The application is same-origin in production;
// explicit development origins keep the Vite workflow usable without exposing
// authenticated APIs to arbitrary web pages.
const DEFAULT_ORIGINS = ['https://laborlens.fyi'];
if (process.env.NODE_ENV !== 'production') DEFAULT_ORIGINS.push('http://localhost:3000', 'http://127.0.0.1:3000');

function configuredOrigins(value = process.env.CORS_ORIGINS) {
    if (!value) return new Set(DEFAULT_ORIGINS);
    return new Set(String(value).split(',').map(item => item.trim()).filter(item => {
        try {
            const url = new URL(item);
            return url.origin === item && ['http:', 'https:'].includes(url.protocol);
        } catch { return false; }
    }));
}

function corsOptions(value) {
    const allowed = configuredOrigins(value);
    return {
        origin(origin, done) {
            // Requests without Origin are server-to-server or same-origin
            // navigations. Unknown browser origins receive no CORS permission.
            done(null, !origin || allowed.has(origin));
        },
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Accept', 'Authorization', 'Content-Type'],
        maxAge: 600,
    };
}

// Hashes cover the two fixed inline scripts in frontend/index.html. Dynamic
// JSON bootstrap/structured-data blocks are non-executable data scripts.
const CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'sha256-3OtDtbXm47YfQYyUcO4lj+qbmPsVdagWiDDFqdw4WCI=' 'sha256-1usDNVo2YcDVX3IF8OVyrMrqLfCvgjtEWhsabjdvPpU=' https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com",
    "manifest-src 'self'",
    "worker-src 'self'",
    'upgrade-insecure-requests',
].join('; ');

function securityHeaders(_req, res, next) {
    res.set({
        'Content-Security-Policy': CSP,
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Permissions-Policy': 'camera=(), microphone=(), payment=(), usb=()',
    });
    next();
}

module.exports = { configuredOrigins, corsOptions, securityHeaders, CSP };
