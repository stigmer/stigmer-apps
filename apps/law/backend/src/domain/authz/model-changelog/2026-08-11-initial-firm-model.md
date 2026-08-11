# 2026-08-11 — Initial firm authorization model

The first FGA model (project DD-003), translating DD-001's who-sees-what
matrix into relationships. Three types:

- `user` — principals are identity user ids, always (FirmMember ids are
  joined to users at projection time).
- `firm` — a singleton (`firm:firm`; the store is the tenancy boundary).
  Six direct role relations (managing_partner, partner, associate,
  junior, clerk, office_staff), the derived groups
  `partners ⊂ lawyers ⊂ case_workers ⊂ member`, and eight `can_*`
  permission verbs for the purely role-shaped matrix rows.
- `case` — `firm` link, `member` (active CaseMember rows), `lead`
  (Case.spec.lead_lawyer_id), and four verbs: `can_work_content` and
  `can_enter_deadline` (both role-intersected memberships or partners),
  `can_edit` and `can_manage_members` (lead or partners).

Deliberately NOT modeled (attribute rules that stay in policy.ts —
DD-003 D3): receipts-only ledger creation, notification recipient,
deadline owner, and the TaskComment→Task case hop.
