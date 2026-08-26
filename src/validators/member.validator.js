const validateCreateMemberInput = function(req, res, next) {
    const { name, phone, planId } = req.body;

    if (!name || !name.trim()) {
        const failure = { title: "Name missing", message: "Name is required", code: 400 };
        return res.status(400).json({ error: 'Name is required', code: 'MISSING_NAME', failure });
    }
    if (!phone || !/^\+?[0-9]{7,15}$/.test(phone)) {
        const failure = { title: "Invalid phone number", message: "Valid phone number is required", code: 400 };
        return res.status(400).json({ error: 'Valid phone number is required', code: 'INVALID_PHONE', failure });
    }
    if (req.body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) {
        const failure = { title: "Invalid email address", message: "Valid email address is required", code: 400 };
        return res.status(400).json({ error: 'Invalid email address', code: 'INVALID_EMAIL', failure });
    }
    if (!planId) {
        const failure = { title: "Plan missing", message: "A valid active membership plan should be selected.", code: 400 };
        return res.status(400).json({ error: 'plan is required', code: 'MISSING_PLAN', failure });
    }
    next();
};

export {validateCreateMemberInput};