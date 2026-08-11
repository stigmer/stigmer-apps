/**
 * New client — half of the intake conversation (J4); the other half
 * (the matter) usually follows immediately, so success lands on the
 * client's page where "New case" is one click away.
 */

import { useNavigate } from "react-router-dom";
import { ClientForm } from "./ClientForm.js";
import { useCreateClient } from "./queries.js";

export function ClientCreateScreen() {
  const createClient = useCreateClient();
  const navigate = useNavigate();

  return (
    <section aria-label="New client">
      <h1 className="mb-4 text-lg font-semibold">New client</h1>
      <ClientForm
        submitLabel="Add client"
        pending={createClient.isPending}
        onSubmit={async (spec) => {
          const created = await createClient.mutateAsync(spec);
          navigate(`/clients/${created.metadata?.id}`);
        }}
        onCancel={() => navigate("/clients")}
      />
    </section>
  );
}
