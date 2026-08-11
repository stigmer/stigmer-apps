/**
 * Task comments (FR-TASK-007): append-only conversation, oldest first BY
 * CONTRACT (the one list that reads downward like a chat) — no edit, no
 * delete, and the screen offers neither. Author and time come from the
 * envelope's audit fields, never duplicated into the spec.
 */

import { useState, type FormEvent } from "react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button } from "../../components/Button.js";
import { FormError, Label, TextArea } from "../../components/Field.js";
import { formatInstant } from "../../lib/format.js";
import { useFirmRoster } from "../members/queries.js";
import { useAddTaskComment, useTaskComments } from "./queries.js";

export function TaskComments(props: { taskId: string }) {
  const comments = useTaskComments(props.taskId);
  const addComment = useAddTaskComment(props.taskId);
  const roster = useFirmRoster();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await addComment.mutateAsync(content.trim());
      setContent("");
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <section aria-label="Comments" className="mt-6 max-w-3xl">
      <h2 className="mb-2 text-sm font-semibold">Comments</h2>

      {comments.isPending && <Loading label="Loading comments…" />}
      {comments.isError && (
        <ErrorState error={comments.error} onRetry={() => void comments.refetch()} />
      )}
      {comments.isSuccess && comments.data.items.length === 0 && (
        <EmptyState title="No comments yet" />
      )}
      {comments.isSuccess && comments.data.items.length > 0 && (
        <ul className="rounded-card border border-line bg-surface">
          {comments.data.items.map((comment) => {
            const createdAt = comment.metadata?.createdAt;
            return (
              <li key={comment.metadata?.id} className="border-b border-line px-3 py-2 last:border-b-0">
                <p className="text-xs text-ink-muted">
                  <span className="font-medium text-ink">
                    {/* Audit fields carry USER ids; the roster maps them. */}
                    {roster.data?.nameOfUser(comment.metadata?.createdBy?.id ?? "") ?? "…"}
                  </span>
                  {createdAt && <> — {formatInstant(timestampDate(createdAt))}</>}
                </p>
                <p className="whitespace-pre-wrap">{comment.spec?.content}</p>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={(e) => void onSubmit(e)} className="mt-3">
        <Label htmlFor="new-comment">Add a comment</Label>
        <TextArea
          id="new-comment"
          required
          maxLength={2000}
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={addComment.isPending}>
          {addComment.isPending ? "Posting…" : "Post comment"}
        </Button>
      </form>
    </section>
  );
}
