// Provider VPC IDs are UUIDs. The value itself is never proof of membership;
// compare it with a provider-exported effective app spec at the approval gate.
export function isApprovedVpcId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
