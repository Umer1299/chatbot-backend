export function buildMasterPrompt(systemPrompt = '', { ragBlock = '', phase = 1 } = {}) {
  return `${ragBlock}${systemPrompt || ''}\nCURRENT CONVERSATION PHASE: ${phase}\n`;
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
