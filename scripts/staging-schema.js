// Authoritative schema contract shared by staging preflight and migration checks.
export const REQUIRED_LEDGER_VERSIONS = ['008', '009', '010', '011', '012', '013'];

export const REQUIRED_TABLES = [
  'businesses', 'bot_configs', 'knowledge_chunks', 'scrape_jobs', 'leads',
  'sessions', 'messages', 'notifications', 'pipeline_stages', 'analytics_daily',
  'model_configs', 'quick_answers', 'inquiries', 'chatbot_settings',
  'chatflow_schema_migrations', 'chatflow_user', 'chatflow_session',
  'chatflow_account', 'chatflow_verification', 'chatflow_organization',
  'chatflow_member', 'chatflow_invitation', 'chatflow_rate_limit',
  'agency_businesses', 'business_memberships', 'agents', 'agent_configs',
  'legacy_agent_mappings', 'website_deployments', 'agent_knowledge_sources',
  'agent_knowledge_chunks', 'agent_chat_sessions', 'agent_chat_messages',
  'agent_leads', 'agent_inquiries', 'agent_chat_turn_claims',
  'legacy_knowledge_mutation_claims',
];

export const REQUIRED_TRIGGERS = [
  'knowledge_revision_insert', 'knowledge_revision_update',
  'knowledge_revision_delete', 'agent_knowledge_revision_insert',
  'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
];
