// Shared offer logic used by the offer controller, createMember, renewMembership
// and revertLastRenewal. Every function takes a Prisma client (or a tx), so the
// same code works inside and outside a transaction.

export class OfferError extends Error {
    constructor(status, error, code, title, message) {
        super(message);
        this.status = status;
        this.error = error;
        this.code = code;
        this.title = title;
    }
}

const round2 = (n) => Math.round(n * 100) / 100;

// Prisma `where` for "enabled and inside its validity window right now"
export const activeNowWhere = (now = new Date()) => ({
    isActive: true,
    AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
    ],
});

// price -> { discountAmount, finalAmount }. Never discounts below zero.
export const computeDiscount = (offer, price) => {
    const value = Number(offer.discountValue);
    let discount = offer.discountType === 'PERCENTAGE' ? (price * value) / 100 : value;
    if (offer.maxDiscountAmount != null) discount = Math.min(discount, Number(offer.maxDiscountAmount));
    discount = round2(Math.min(Math.max(discount, 0), price));
    return { discountAmount: discount, finalAmount: round2(price - discount) };
};

const appliesToPlan = (offer, planId) =>
    offer.appliesToAllPlans || (offer.plans || []).some((p) => p.id === planId);

const appliesToContext = (offer, context) =>
    !context || offer.appliesTo === 'BOTH' || offer.appliesTo === context;

const hasCapacity = (offer) => offer.maxRedemptions == null || offer.redemptionCount < offer.maxRedemptions;

// Shape returned to the app, with the discount previewed for a given plan
export const toPublicOffer = (offer, plan) => {
    const quote = plan ? computeDiscount(offer, Number(plan.price)) : null;
    return {
        id: offer.id,
        name: offer.name,
        code: offer.code,
        description: offer.description,
        discountType: offer.discountType,
        discountValue: Number(offer.discountValue),
        maxDiscountAmount: offer.maxDiscountAmount == null ? null : Number(offer.maxDiscountAmount),
        appliesTo: offer.appliesTo,
        validFrom: offer.validFrom,
        validUntil: offer.validUntil,
        ...(quote ? { originalAmount: Number(plan.price), ...quote } : {}),
    };
};

// One query for every offer that is live right now (with the plan ids it is
// linked to). Callers filter per plan in memory with offersForPlan().
export const listActiveOffers = (client, { context } = {}) =>
    client.offer.findMany({
        where: {
            ...activeNowWhere(),
            ...(context ? { appliesTo: { in: [context, 'BOTH'] } } : {}),
        },
        include: { plans: { select: { id: true } } },
        orderBy: { createdAt: 'desc' },
    });

export const offersForPlan = (offers, plan) =>
    offers.filter((o) => hasCapacity(o) && appliesToPlan(o, plan.id)).map((o) => toPublicOffer(o, plan));

// Validates an offer for a plan (+ member, on renewal) and returns the quote.
// Throws OfferError with a ready-to-send failure payload.
export const resolveOffer = async (client, { offerId, offerCode, plan, memberId = null, context }) => {
    const where = offerId ? { id: offerId } : { code: String(offerCode).trim().toUpperCase() };
    const offer = await client.offer.findUnique({ where, include: { plans: { select: { id: true } } } });
    const now = new Date();

    const bad = (status, code, title, message) => new OfferError(status, title, code, title, message);

    if (!offer) throw bad(404, 'OFFER_NOT_FOUND', 'Offer not found', 'This offer does not exist.');
    if (!offer.isActive) throw bad(400, 'OFFER_INACTIVE', 'Offer inactive', 'This offer is no longer active.');
    if (offer.validFrom && offer.validFrom > now) {
        throw bad(400, 'OFFER_NOT_STARTED', 'Offer not started', 'This offer is not valid yet.');
    }
    if (offer.validUntil && offer.validUntil < now) {
        throw bad(400, 'OFFER_EXPIRED', 'Offer expired', 'This offer has expired.');
    }
    if (!appliesToContext(offer, context)) {
        throw bad(
            400,
            'OFFER_NOT_APPLICABLE',
            'Offer not applicable',
            context === 'RENEWAL' ? 'This offer is not valid for renewals.' : 'This offer is only valid for renewals.'
        );
    }
    if (!appliesToPlan(offer, plan.id)) {
        throw bad(400, 'OFFER_PLAN_MISMATCH', 'Offer not applicable', 'This offer is not valid for the selected plan.');
    }
    if (!hasCapacity(offer)) {
        throw bad(409, 'OFFER_EXHAUSTED', 'Offer fully redeemed', 'This offer has reached its redemption limit.');
    }
    if (memberId && offer.perUserLimit != null) {
        const used = await client.userOffer.count({ where: { userId: memberId, offerId: offer.id } });
        if (used >= offer.perUserLimit) {
            throw bad(409, 'OFFER_LIMIT_REACHED', 'Offer already used', 'This member has already used this offer the maximum number of times.');
        }
    }

    return { offer, originalAmount: Number(plan.price), ...computeDiscount(offer, Number(plan.price)) };
};

// Call inside the same transaction that creates the fee record. The conditional
// updateMany makes the global cap safe under concurrent requests.
export const recordRedemption = async (tx, { quote, userId, feeRecordId, source }) => {
    const { offer } = quote;

    const claimed = await tx.offer.updateMany({
        where: {
            id: offer.id,
            ...(offer.maxRedemptions != null ? { redemptionCount: { lt: offer.maxRedemptions } } : {}),
        },
        data: { redemptionCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
        throw new OfferError(409, 'Offer fully redeemed', 'OFFER_EXHAUSTED', 'Offer fully redeemed', 'This offer has reached its redemption limit.');
    }

    return tx.userOffer.create({
        data: {
            userId,
            offerId: offer.id,
            feeRecordId,
            source,
            offerName: offer.name,
            discountType: offer.discountType,
            discountValue: offer.discountValue,
            originalAmount: quote.originalAmount,
            discountAmount: quote.discountAmount,
            finalAmount: quote.finalAmount,
        },
    });
};

// Undo redemptions tied to fee records that are about to be deleted
// (revertLastRenewal). Frees the slot on the offer's counters.
export const releaseRedemptions = async (tx, feeRecordIds) => {
    const rows = await tx.userOffer.findMany({
        where: { feeRecordId: { in: feeRecordIds } },
        select: { id: true, offerId: true },
    });
    for (const row of rows) {
        await tx.offer.update({ where: { id: row.offerId }, data: { redemptionCount: { decrement: 1 } } });
    }
    if (rows.length) await tx.userOffer.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
};

export default {
    activeNowWhere,
    computeDiscount,
    toPublicOffer,
    listActiveOffers,
    offersForPlan,
    resolveOffer,
    recordRedemption,
    releaseRedemptions,
};