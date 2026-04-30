const SEASONAL_CONTEXTS = {
  construction: [
    {
      months: [11, 12, 1, 2],
      label: 'Winter Season',
      chatbotHint:
        'It is currently winter. When relevant mention: Now is a good time to assess storm or cold damage before it gets worse. Indoor renovation projects are ideal this time. Spring bookings fill up fast suggest booking now. Emergency roof or pipe damage is common in winter emphasise fast response capability.',
      urgencyBoost: true,
      suggestedTopics: ['storm damage assessment', 'indoor renovations', 'spring booking availability', 'emergency repairs'],
    },
    { months: [3, 4, 5], label: 'Spring Season', chatbotHint: 'It is currently spring. When relevant mention: Spring is the busiest season slots book quickly. Perfect time for outdoor projects driveways roofing landscaping foundations. Post-winter damage assessments are popular now. Recommend booking early to secure preferred dates.', urgencyBoost: false, suggestedTopics: ['spring project planning', 'outdoor renovations', 'post-winter assessment', 'early booking advantage'] },
    { months: [6, 7, 8], label: 'Summer Season', chatbotHint: 'It is currently summer. When relevant mention: Peak season team is busy but taking bookings. Best weather for large outdoor projects. Commercial projects often scheduled in summer. Longer daylight hours mean faster completion.', urgencyBoost: false, suggestedTopics: ['large outdoor projects', 'commercial work', 'summer scheduling'] },
    { months: [9, 10], label: 'Autumn Season', chatbotHint: 'It is currently autumn. When relevant mention: Last chance for outdoor projects before winter. Roof and gutter checks before winter storms. Heating system and insulation upgrades popular. Book now to avoid winter emergency pricing.', urgencyBoost: true, suggestedTopics: ['pre-winter preparation', 'roof and gutter checks', 'insulation upgrades', 'winter readiness'] },
  ],
  'web agency': [
    { months: [1, 2], label: 'New Year Planning', chatbotHint: 'It is the new year. When relevant mention: Many businesses are planning digital strategy and budget for the year. Great time to launch before Q2 campaigns. January is ideal for discovery and planning.', urgencyBoost: false, suggestedTopics: ['new year digital strategy', 'Q1 launch planning'] },
    { months: [9, 10, 11], label: 'Pre-Holiday Push', chatbotHint: 'It is the pre-holiday period. When relevant mention: E-commerce sites need to be ready before Black Friday and Christmas. This is the busiest web project season. Limited availability recommend booking quickly.', urgencyBoost: true, suggestedTopics: ['Black Friday readiness', 'holiday e-commerce', 'Q4 launch deadline'] },
    { months: [3, 4, 5, 6, 7, 8, 12], label: 'Standard Season', chatbotHint: null, urgencyBoost: false, suggestedTopics: [] },
  ],
  'real estate': [
    { months: [3, 4, 5, 6], label: 'Peak Buying Season', chatbotHint: 'It is peak property season. When relevant mention: Spring and early summer are busiest for transactions. More properties coming to market right now. Buyers are very active viewings book fast. Pre-approved buyers have a strong advantage.', urgencyBoost: true, suggestedTopics: ['spring market activity', 'mortgage pre-approval advantage', 'fast moving market'] },
    { months: [11, 12], label: 'Quiet Season', chatbotHint: 'It is the quieter season for property. When relevant mention: Less competition from other buyers right now. Sellers are motivated good negotiation opportunity. Great time to get pre-approved for spring market.', urgencyBoost: false, suggestedTopics: ['motivated sellers', 'less competition', 'spring preparation'] },
    { months: [1, 2, 7, 8, 9, 10], label: 'Standard Season', chatbotHint: null, urgencyBoost: false, suggestedTopics: [] },
  ],
  healthcare: [
    { months: [1], label: 'New Year Health', chatbotHint: 'It is the new year. When relevant mention: Many patients have new or renewed insurance starting January worth checking coverage. New year health check-ups and screenings are very popular right now. Slots book fast in January recommend booking early.', urgencyBoost: false, suggestedTopics: ['new year health goals', 'insurance renewal', 'annual check-ups'] },
    { months: [11, 12], label: 'Year-End', chatbotHint: 'It is year-end. When relevant mention: Many patients want to use remaining insurance allowance before year-end. Book now before the holiday period. January is typically busy booking ahead recommended.', urgencyBoost: true, suggestedTopics: ['use insurance before year-end', 'holiday scheduling', 'January pre-booking'] },
    { months: [2, 3, 4, 5, 6, 7, 8, 9, 10], label: 'Standard Season', chatbotHint: null, urgencyBoost: false, suggestedTopics: [] },
  ],
  'law firm': [
    { months: [1, 2], label: 'Post-Holiday Legal', chatbotHint: 'It is the new year. When relevant mention: January sees high demand for family law matters following the holiday period. Many businesses start new contracts needing legal review at the start of the year. Employment disputes often arise after year-end performance reviews.', urgencyBoost: false, suggestedTopics: ['family law enquiries', 'new business contracts', 'employment matters'] },
    { months: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], label: 'Standard Season', chatbotHint: null, urgencyBoost: false, suggestedTopics: [] },
  ],
};

export function getSeasonalContext(industry) {
  const currentMonth = new Date().getMonth() + 1;
  const contexts = SEASONAL_CONTEXTS[industry?.toLowerCase?.() || ''];

  if (!Array.isArray(contexts)) {
    return null;
  }

  return contexts.find((context) => context.months.includes(currentMonth)) || null;
}

export { SEASONAL_CONTEXTS };
