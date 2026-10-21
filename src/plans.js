'use strict';
// Plan placeholders — edit prices in Stripe and labels in .env
function plans() {
  return {
    free: { id: 'free', name: 'Free Trial', price: '£0', searches: +(process.env.FREE_SEARCHES || 3), results: 3, features: ['3 recipe searches','Up to 3 recipes per search','Print & share'] },
    monthly: { id: 'monthly', name: 'Chef Monthly', price: process.env.PRICE_MONTHLY_LABEL || '£4.99', priceId: process.env.STRIPE_PRICE_MONTHLY, searches: Infinity, results: 5, features: ['Unlimited AI chef searches','Up to 5 ranked recipes','Favourites & history','Shopping lists','Kids mode'] },
    family: { id: 'family', name: 'Family Kitchen', price: process.env.PRICE_FAMILY_LABEL || '£7.99', priceId: process.env.STRIPE_PRICE_FAMILY, searches: Infinity, results: 5, features: ['Everything in Monthly','Up to 5 family members (roadmap)','Kids mode & lunchbox planner','Priority Malcolm AI'] }
  };
}
const isPremium = u => !!u && u.plan !== 'free' && ['active', 'trialing'].includes(u.sub_status);
module.exports = { plans, isPremium };
