// Drizzle schema barrel — every table exports from here so drizzle-kit picks
// them up and Drizzle's relational queries can resolve references.

export * from './users';
export * from './workspaces';
export * from './workspace-members';
export * from './workspace-ai-profiles';
export * from './gmail-accounts';
export * from './campaigns';
export * from './campaign-goals';
export * from './campaign-knowledge-files';
export * from './campaign-lead-sources';
export * from './leads';
export * from './email-threads';
export * from './email-messages';
export * from './ai-actions';
export * from './campaign-training-sessions';
export * from './campaign-training-messages';
export * from './campaign-playbooks';
export * from './campaign-demo-guides';
export * from './campaign-exit-rules';
export * from './campaign-test-scenarios';
export * from './suppression-list';
export * from './domain-health-checks';
export * from './handoffs';
export * from './calendar-events';
export * from './notifications';
export * from './notification-settings';
export * from './push-subscriptions';
