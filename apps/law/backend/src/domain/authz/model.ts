/**
 * The firm's FGA authorization model (project DD-003) — the relationship
 * half of DD-001's who-sees-what matrix. Attribute-shaped rules
 * (receipts-only, notification recipient, deadline owner, the
 * TaskComment→Task hop) stay in policy.ts; forcing them into tuples
 * would mean a tuple per ephemeral row (the known FGA anti-pattern).
 *
 * The DSL lives in this TS module rather than a standalone `.fga` file
 * because the backend ships as a single esbuild bundle and dev runs
 * under tsx — an embedded string is the one form every runtime loads
 * identically, with no copy step to drift. Model revisions are recorded
 * in ./model-changelog/ (the stigmer-cloud fga/changelog discipline);
 * the file-per-type split is the recorded convention to adopt if this
 * model ever grows past a screenful.
 *
 * `firm` is a singleton object (`firm:firm` — see FIRM_OBJECT in
 * tuples.ts): one deployment is one firm by design (T04b D1), so the
 * STORE is the tenancy boundary and the object id is structural.
 */

export const LAW_AUTHZ_MODEL_DSL = `model
  schema 1.1

type user

type firm
  relations
    # The six role relations — exactly DD-001's vocabulary. A person
    # holds exactly one (FirmMember's natural key enforces 1:1 with the
    # user); deactivation deletes the tuple (FR-MEMBER-002), and the
    # policy's DB liveness check backs it up (DD-003 D1a).
    define managing_partner: [user]
    define partner: [user]
    define associate: [user]
    define junior: [user]
    define clerk: [user]
    define office_staff: [user]

    # The derived groups the policy's role arrays compile to.
    define partners: managing_partner or partner
    define lawyers: partners or associate or junior
    define case_workers: lawyers or clerk
    define member: case_workers or office_staff

    # Firm-level permission verbs — matrix rows that are purely
    # role-shaped, one verb per row, named in matrix language.
    define can_manage_firm_members: managing_partner
    define can_create_case: partners or associate
    define can_manage_clients: partners or associate
    define can_view_clients: lawyers
    define can_list_cases: case_workers
    define can_view_money: partners
    define can_record_ledger: partners or office_staff
    define can_view_audit: partners

type case
  relations
    define firm: [firm]
    # Active case membership (CaseMember rows, status.active=true);
    # removal is a soft-close that deletes the tuple.
    define member: [user]
    # The matter's lead lawyer (Case.spec.lead_lawyer_id, joined to the
    # user through the FirmMember row at projection time).
    define lead: [user]

    # Case content (FR-AUTHZ-002): partners firm-wide; otherwise an
    # ACTIVE member who holds a case-worker role. The intersection
    # mirrors the policy's role-gate-then-membership order — a
    # membership tuple alone grants nothing to a role outside the group.
    define can_work_content: (member and case_workers from firm) or partners from firm
    # Deadline entry (FR-DEAD-001): same shape, lawyers only — clerks
    # see deadlines on their cases but never enter them.
    define can_enter_deadline: (member and lawyers from firm) or partners from firm
    # Case management (FR-CASE-002/003): the lead or a partner.
    define can_edit: lead or partners from firm
    define can_manage_members: lead or partners from firm
`;
