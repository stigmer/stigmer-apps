/** New case (FR-CASE-001) — the shared CaseForm over the create mutation. */

import { useNavigate } from "react-router-dom";
import { CaseForm } from "./CaseForm.js";
import { useCreateCase } from "./queries.js";

export function CaseCreateScreen() {
  const createCase = useCreateCase();
  const navigate = useNavigate();

  return (
    <section aria-label="New case" className="max-w-lg">
      <h1 className="mb-4 text-xl font-semibold">New case</h1>
      <CaseForm
        submitLabel="Create case"
        pending={createCase.isPending}
        onSubmit={async (spec) => {
          const created = await createCase.mutateAsync(spec);
          navigate(`/cases/${created.metadata?.id}`);
        }}
        onCancel={() => navigate("/cases")}
      />
    </section>
  );
}
