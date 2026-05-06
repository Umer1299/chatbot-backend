import { AGENT_TEMPLATES } from './templates.js';

function titleize(value = '') {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function buildAgentPromptInstructions(industry, selectedAgents = []) {
  const template = AGENT_TEMPLATES[industry];
  if (!template || !template.agents || !Array.isArray(selectedAgents)) {
    return { prompt: '', usedAgents: [] };
  }

  const usedAgents = [];
  const blocks = [];

  for (const agentId of selectedAgents) {
    const agent = template.agents[agentId];
    if (!agent) {
      console.warn('[agents] Unknown selected agent ignored', { industry, agentId });
      continue;
    }

    usedAgents.push(agentId);
    blocks.push([
      `AGENT: ${agent.name} (${agent.id})`,
      `Goal: ${agent.description}`,
      `Behavior: ${agent.promptInstructions}`,
      `Lead fields to collect: ${(agent.collectsFields || []).join(', ') || 'none'}`,
      `Objection handling: acknowledge concerns, answer briefly with business context, then return to ${agent.name} goal.`,
      `Next step instructions: if this agent's required fields are complete, move forward and include PHASE_${agent.phase}_COMPLETE when appropriate.`
    ].join('\n'));
  }

  const prompt = blocks.length > 0
    ? `SELECTED AGENTS (${template.industryName}):\n${blocks.join('\n\n')}`
    : '';

  return { prompt, usedAgents };
}

export function buildMasterPrompt(businessInfo = {}, selectedAgents = [], availability = {}) {
  const industry = businessInfo?.industry || '';
  const { prompt: agentPrompt, usedAgents } = buildAgentPromptInstructions(industry, selectedAgents);

  const base = [
    `You are an AI assistant for ${businessInfo?.businessName || 'this business'}.`,
    `Industry: ${titleize(industry || 'general')}.`,
    businessInfo?.location ? `Service location: ${businessInfo.location}.` : null,
    Array.isArray(businessInfo?.primaryServices) && businessInfo.primaryServices.length
      ? `Primary services: ${businessInfo.primaryServices.join(', ')}.` : null,
    businessInfo?.ownerPhone ? `Business phone: ${businessInfo.ownerPhone}.` : null,
    businessInfo?.calendlyLink ? `Calendly: ${businessInfo.calendlyLink}.` : null,
    Object.keys(availability || {}).length ? `Availability slots: ${JSON.stringify(availability)}.` : null,
    'Keep responses concise, practical, and conversion-oriented.'
  ].filter(Boolean).join('\n');

  return { prompt: `${base}\n\n${agentPrompt}`.trim(), usedAgents };
}

export function generateProjectDetails(industry, leadData = {}) {
  const parts = [
    `Industry: ${industry || 'general'}`,
    `Name: ${leadData.name || 'unknown'}`,
    `Project Type: ${leadData.project_type || 'inquiry'}`,
    `Needs: ${leadData.needs || leadData.message || 'not specified'}`,
    `Budget: ${leadData.budget_range || 'unknown'}`,
  ];
  return parts.join(' | ');
}
