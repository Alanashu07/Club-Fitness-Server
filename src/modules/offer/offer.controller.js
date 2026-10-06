import prisma from '../../config/db.js';
import { fail } from '../../validators/error.handler.js';
import offerService, { OfferError } from './offer.service.js';

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const DISCOUNT_TYPES = ['PERCENTAGE', 'FLAT'];
const APPLIES_TO = ['NEW_MEMBER', 'RENEWAL', 'BOTH'];

const bad = (message, code = 'INVALID_OFFER') => new OfferError(400, 'Invalid offer', code, 'Invalid offer', message);

const toDate = (v) => (v ? new Date(v) : null);
const toNumOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Normalises the request body into Prisma data (only the keys that were sent)
const pickOfferData = (b) => {
    const d = {};
    if (b.name !== undefined) d.name = String(b.name).trim();
    if (b.code !== undefined) d.code = b.code ? String(b.code).trim().toUpperCase() : null;
    if (b.description !== undefined) d.description = b.description || null;
    if (b.discountType !== undefined) d.discountType = b.discountType;
    if (b.discountValue !== undefined) d.discountValue = Number(b.discountValue);
    if (b.maxDiscountAmount !== undefined) d.maxDiscountAmount = toNumOrNull(b.maxDiscountAmount);
    if (b.appliesTo !== undefined) d.appliesTo = b.appliesTo;
    if (b.appliesToAllPlans !== undefined) d.appliesToAllPlans = b.appliesToAllPlans === true || b.appliesToAllPlans === 'true';
    if (b.validFrom !== undefined) d.validFrom = toDate(b.validFrom);
    if (b.validUntil !== undefined) d.validUntil = toDate(b.validUntil);
    if (b.maxRedemptions !== undefined) d.maxRedemptions = toNumOrNull(b.maxRedemptions);
    if (b.perUserLimit !== undefined) d.perUserLimit = toNumOrNull(b.perUserLimit);
    if (b.isActive !== undefined) d.isActive = b.isActive === true || b.isActive === 'true';
    return d;
};

// Validates the final (merged) offer so partial PATCHes can't create bad states
const validateOffer = (o) => {
    if (!o.name) throw bad('Offer name is required.');
    if (!DISCOUNT_TYPES.includes(o.discountType)) throw bad('discountType must be PERCENTAGE or FLAT.');
    if (!(Number(o.discountValue) > 0)) throw bad('discountValue must be greater than 0.');
    if (o.discountType === 'PERCENTAGE' && Number(o.discountValue) > 100) throw bad('A percentage discount cannot exceed 100.');
    if (o.maxDiscountAmount != null && !(Number(o.maxDiscountAmount) > 0)) throw bad('maxDiscountAmount must be greater than 0.');
    if (o.appliesTo && !APPLIES_TO.includes(o.appliesTo)) throw bad('appliesTo must be NEW_MEMBER, RENEWAL or BOTH.');
    for (const k of ['validFrom', 'validUntil']) {
        if (o[k] && Number.isNaN(new Date(o[k]).getTime())) throw bad(`${k} is not a valid date.`, 'INVALID_DATE');
    }
    if (o.validFrom && o.validUntil && new Date(o.validFrom) > new Date(o.validUntil)) {
        throw bad('validFrom must be before validUntil.', 'INVALID_DATE_RANGE');
    }
    for (const k of ['maxRedemptions', 'perUserLimit']) {
        if (o[k] != null && !(Number.isInteger(Number(o[k])) && Number(o[k]) >= 1)) throw bad(`${k} must be a whole number >= 1.`);
    }
};

const assertPlansExist = async (planIds) => {
    const count = await prisma.membershipPlan.count({ where: { id: { in: planIds } } });
    if (count !== new Set(planIds).size) throw bad('One or more planIds do not exist.', 'INVALID_PLAN');
};

// Turns thrown OfferErrors / unique-code clashes into the app's failure format
const handleOfferErrors = (req, res, err) => {
    if (err instanceof OfferError) return fail(req, res, err.status, err.error, err.code, err.title, err.message);
    if (err.code === 'P2002') {
        return fail(req, res, 409, 'Offer code in use', 'OFFER_CODE_EXISTS', 'Code already used', 'Another offer already uses this code.');
    }
    throw err;
};

const offerInclude = { plans: { select: { id: true, name: true } } };

// ── POST /api/v1/admin/offers ───────────────────────────────────────────────
// body: name, discountType, discountValue, [code, description, maxDiscountAmount,
//   appliesTo, appliesToAllPlans, planIds[], validFrom, validUntil,
//   maxRedemptions, perUserLimit, isActive]
const createOffer = asyncHandler(async (req, res) => {
    try {
        const data = pickOfferData(req.body);
        const planIds = Array.isArray(req.body.planIds) ? req.body.planIds : [];
        validateOffer(data);
        if (!data.appliesToAllPlans && planIds.length === 0) {
            throw bad('Select at least one plan, or set appliesToAllPlans to true.', 'PLAN_REQUIRED');
        }
        if (planIds.length) await assertPlansExist(planIds);

        const offer = await prisma.offer.create({
            data: { ...data, plans: { connect: planIds.map((id) => ({ id })) } },
            include: offerInclude,
        });
        res.status(201).json({ offer });
    } catch (err) {
        return handleOfferErrors(req, res, err);
    }
});

// ── GET /api/v1/admin/offers ────────────────────────────────────────────────
// ?search= &planId= &active=true|false &validNow=true &appliesTo=
const listOffers = asyncHandler(async (req, res) => {
    const { search = '', planId, active, validNow, appliesTo } = req.query;
    const and = [];

    if (search.trim()) {
        and.push({
            OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
            ],
        });
    }
    if (planId) and.push({ OR: [{ appliesToAllPlans: true }, { plans: { some: { id: planId } } }] });
    if (active === 'true' || active === 'false') and.push({ isActive: active === 'true' });
    if (validNow === 'true') and.push(offerService.activeNowWhere());
    if (appliesTo) and.push({ appliesTo: { in: [appliesTo, 'BOTH'] } });

    const offers = await prisma.offer.findMany({
        where: and.length ? { AND: and } : {},
        include: offerInclude,
        orderBy: { createdAt: 'desc' },
    });
    res.json({ offers });
});

// ── GET /api/v1/admin/offers/:id ────────────────────────────────────────────
const getOffer = asyncHandler(async (req, res) => {
    const offer = await prisma.offer.findUnique({
        where: { id: req.params.id },
        include: {
            ...offerInclude,
            redemptions: {
                orderBy: { redeemedAt: 'desc' },
                take: 50,
                include: { user: { select: { id: true, name: true, phone: true } } },
            },
        },
    });
    if (!offer) return fail(req, res, 404, 'Offer not found', 'OFFER_NOT_FOUND', 'Offer not found', 'No offer exists with this id.');
    res.json({ offer });
});

// ── PATCH /api/v1/admin/offers/:id ──────────────────────────────────────────
// planIds (if sent) REPLACES the linked plans.
const updateOffer = asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await prisma.offer.findUnique({ where: { id }, include: { plans: { select: { id: true } } } });
        if (!existing) return fail(req, res, 404, 'Offer not found', 'OFFER_NOT_FOUND', 'Offer not found', 'No offer exists with this id.');

        const data = pickOfferData(req.body);
        const merged = { ...existing, ...data };
        validateOffer(merged);

        const planIds = Array.isArray(req.body.planIds) ? req.body.planIds : null;
        const finalPlanCount = planIds ? planIds.length : existing.plans.length;
        if (!merged.appliesToAllPlans && finalPlanCount === 0) {
            throw bad('Select at least one plan, or set appliesToAllPlans to true.', 'PLAN_REQUIRED');
        }
        if (planIds?.length) await assertPlansExist(planIds);

        const offer = await prisma.offer.update({
            where: { id },
            data: { ...data, ...(planIds ? { plans: { set: planIds.map((p) => ({ id: p })) } } : {}) },
            include: offerInclude,
        });
        res.json({ offer });
    } catch (err) {
        return handleOfferErrors(req, res, err);
    }
});

// ── DELETE /api/v1/admin/offers/:id ─────────────────────────────────────────
// Offers that were ever redeemed are kept for history: deactivate instead.
const deleteOffer = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const offer = await prisma.offer.findUnique({ where: { id }, select: { id: true } });
    if (!offer) return fail(req, res, 404, 'Offer not found', 'OFFER_NOT_FOUND', 'Offer not found', 'No offer exists with this id.');

    const used = await prisma.userOffer.count({ where: { offerId: id } });
    if (used > 0) {
        return fail(
            req, res, 409, 'Offer in use', 'OFFER_IN_USE', 'Offer in use',
            `This offer was redeemed ${used} time(s). Deactivate it instead (PATCH isActive=false).`
        );
    }
    await prisma.offer.delete({ where: { id } });
    res.json({ message: 'Offer deleted successfully!' });
});

// ── GET /api/v1/admin/membership-plans/:planId/offers ───────────────────────
// ?context=NEW_MEMBER|RENEWAL  &memberId=  (hides offers that member has used up)
// Returns only offers redeemable right now, each with the discounted price.
const listOffersForPlan = asyncHandler(async (req, res) => {
    const { planId } = req.params;
    const { context, memberId } = req.query;

    const plan = await prisma.membershipPlan.findUnique({ where: { id: planId } });
    if (!plan) return fail(req, res, 404, 'Plan not found', 'PLAN_NOT_FOUND', 'Plan not found', 'No plan exists with this id.');

    const active = await offerService.listActiveOffers(prisma, { context });
    let offers = offerService.offersForPlan(active, plan);

    if (memberId && offers.length) {
        const used = await prisma.userOffer.groupBy({
            by: ['offerId'],
            where: { userId: memberId, offerId: { in: offers.map((o) => o.id) } },
            _count: { _all: true },
        });
        const usedMap = new Map(used.map((u) => [u.offerId, u._count._all]));
        const limits = new Map(active.map((o) => [o.id, o.perUserLimit]));
        offers = offers.filter((o) => limits.get(o.id) == null || (usedMap.get(o.id) || 0) < limits.get(o.id));
    }

    res.json({ plan: { id: plan.id, name: plan.name, price: Number(plan.price) }, offers });
});

export default {
    createOffer,
    listOffers,
    getOffer,
    updateOffer,
    deleteOffer,
    listOffersForPlan,
};