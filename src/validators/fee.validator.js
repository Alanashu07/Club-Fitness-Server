const FEE_STATUSES = ['PENDING', 'OVERDUE', 'PAID', 'PARTIAL', 'WAIVED'];
const PAYMENT_METHODS = ['cash', 'upi', 'bankTransfer', 'other'];

export function validateCreateFeeInput(req, res, next) {
    const { memberId, amount, dueDate, status } = req.body;
    const errors = [];

    if (!memberId) errors.push('memberId is required');
    if (amount === undefined || Number(amount) < 0) errors.push('amount must be a non-negative number');
    if (!dueDate || Number.isNaN(new Date(dueDate).getTime())) errors.push('dueDate must be a valid date');
    if (status && !FEE_STATUSES.includes(String(status).toUpperCase())) {
        errors.push(`status must be one of: ${FEE_STATUSES.join(', ')}`);
    }

    if (errors.length) {
        const failure = { title: 'Invalid fee record', message: errors.join('; '), code: 400 };
        return res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', errors, failure });
    }
    next();
}

export function validateMarkPaidInput(req, res, next) {
    const { amountReceived, method } = req.body;
    const errors = [];

    if (amountReceived === undefined || Number(amountReceived) <= 0) {
        errors.push('amountReceived must be greater than zero');
    }
    if (method && !PAYMENT_METHODS.includes(method)) {
        errors.push(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }

    if (errors.length) {
        const failure = { title: 'Invalid payment details', message: errors.join('; '), code: 400 };
        return res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', errors, failure });
    }
    next();
}

export function validateReminderInput(req, res, next) {
    const { channels } = req.body;
    if (channels !== undefined) {
        const valid = ['push', 'whatsapp', 'sms'];
        if (!Array.isArray(channels) || channels.some((c) => !valid.includes(c))) {
            const failure = {
                title: 'Invalid channels',
                message: `channels must be an array containing any of: ${valid.join(', ')}`,
                code: 400,
            };
            return res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', failure });
        }
    }
    next();
}