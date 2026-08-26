// validators/auth.validator.js
const validateLoginInput = function(req, res, next) {
    const { identifier, password } = req.body;

    if (!identifier || typeof identifier !== 'string') {
        return res.status(400).json({ error: 'phone or email is required', code: 'MISSING_IDENTIFIER' });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'Password is required', code: 'MISSING_PASSWORD' });
    }
    next();
}

const validateRegisterInput = function(req, res, next) {
    const { name, phone, password } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required', code: 'MISSING_NAME' });
    }
    if (!phone || !/^\+?[0-9]{7,15}$/.test(phone)) {
        return res.status(400).json({ error: 'Valid phone number is required', code: 'INVALID_PHONE' });
    }
    if (!password) {
        return res.status(400).json({ error: 'Password is required', code: 'MISSING_PASSWORD' });
    }
    next();
}

export { validateLoginInput, validateRegisterInput };