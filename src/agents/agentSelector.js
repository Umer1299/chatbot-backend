import { AGENT_TEMPLATES } from './templates.js';

export function suggestAgents(industry, analysisResult, scrapedText) {
  if (!AGENT_TEMPLATES[industry]) {
    return null;
  }

  const template = AGENT_TEMPLATES[industry];
  const suggestedAgentIds = [];
  const selectionReasons = {};
  const lockedAgentIds = [];

  const services = Array.isArray(analysisResult?.primaryServices)
    ? analysisResult.primaryServices.join(' ').toLowerCase()
    : '';
  const combinedText = `${services} ${(scrapedText || '').toLowerCase()}`;

  for (const [agentId, agent] of Object.entries(template.agents || {})) {
    if (agent.locked === true) {
      suggestedAgentIds.push(agentId);
      lockedAgentIds.push(agentId);
      selectionReasons[agentId] = `Required for all ${industry} businesses`;
      continue;
    }

    if (agent.recommended === true) {
      suggestedAgentIds.push(agentId);
      selectionReasons[agentId] = `Essential for all ${industry} businesses`;
      continue;
    }

    if (Array.isArray(agent.triggerKeywords) && agent.triggerKeywords.length > 0) {
      const matchedWords = agent.triggerKeywords.filter((keyword) =>
        combinedText.includes(String(keyword).toLowerCase())
      );

      if (matchedWords.length > 0) {
        suggestedAgentIds.push(agentId);
        selectionReasons[agentId] = `Your site mentions: ${matchedWords.join(', ')}`;
      }
    }
  }

  const availableAgentIds = Object.keys(template.agents || {});

  return {
    industry,
    industryName: template.industryName,
    emoji: template.emoji,
    suggestedAgentIds,
    availableAgentIds,
    agentDetails: template.agents,
    selectionReasons,
    lockedAgentIds,
  };
}

export function getAgentById(industry, agentId) {
  return AGENT_TEMPLATES[industry]?.agents[agentId] || null;
}
