import {HttpError} from './http.mjs';
import {isOrganizationId} from './alpha-projects.mjs';

// Read the revision before counting. Every admission advances it in the membership transaction, so two callers
// cannot spend the same last seat. Removals need no fence: they only make more room. Legacy rows start at revision 0.
export async function seatAdmission(store, owner, newMember) {
  const Key = {pk: 'TENANT#' + owner, sk: 'WORKSPACE#META'}, meta = await store._get(Key);
  const revision = meta?.membership_revision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new HttpError(503, 'membership_unavailable');
  const rows = await store._page(Key.pk, 'MEMBER#', {limit: 20});
  if (rows.next) throw new HttpError(503, 'workspace_list_incomplete');
  const active = rows.items.filter(row => row.active === true).length + (isOrganizationId(owner) ? 0 : 1);
  return {active, item: {Update: {
    Key, UpdateExpression: 'ADD membership_revision :one' + (newMember ? ', members :one' : ''),
    ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND ' +
      (revision === undefined ? 'attribute_not_exists(membership_revision)' : 'membership_revision = :revision') +
      (newMember ? ' AND members < :cap' : ''),
    ExpressionAttributeValues: {':one': 1, ...(revision === undefined ? {} : {':revision': revision}), ...(newMember ? {':cap': 20} : {})},
  }}};
}
