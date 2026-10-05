const fail = (req, res, code, error, errorCode, title, message) =>
        res.status(code).json({ error, code: errorCode, failure: { title, message, code } });

export { fail };