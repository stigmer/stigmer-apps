/**
 * The matter's money (FR-MONEY-*, partner-only — this component mounts
 * only for partner roles; the server refuses everyone else regardless):
 * the fee arrangement, the append-only ledger, and entry capture.
 * Amounts are integer paise end to end; corrections are contra entries,
 * so there is no edit and no delete — exactly like the ledger book.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button } from "../../components/Button.js";
import {
  FormError,
  InlineInput,
  InlineSelect,
  Input,
  Label,
  Select,
} from "../../components/Field.js";
import { Pagination } from "../../components/Pagination.js";
import { FeeKind } from "../../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import {
  LedgerEntryKind,
  LedgerEntrySpecSchema,
} from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { firmToday } from "../../lib/firm-day.js";
import {
  feeKindLabel,
  formatCalendarDate,
  formatInstant,
  formatPaise,
  ledgerEntryKindLabel,
  parseRupeesToPaise,
} from "../../lib/format.js";
import {
  FeeArrangementSpecSchema,
  useFeeArrangement,
  useLedgerEntries,
  useRecordLedgerEntry,
  useSaveFeeArrangement,
} from "../money/queries.js";

const FEE_KINDS: readonly FeeKind[] = [
  FeeKind.LUMP_SUM,
  FeeKind.PER_APPEARANCE,
  FeeKind.RETAINER,
  FeeKind.NOT_SET,
];

function FeeArrangementForm(props: { caseId: string }) {
  const arrangement = useFeeArrangement(props.caseId);
  const save = useSaveFeeArrangement();
  const existing = arrangement.data;
  const spec = existing?.spec;

  const [kind, setKind] = useState<FeeKind | undefined>();
  const [amount, setAmount] = useState<string | undefined>();
  const [terms, setTerms] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  // Server state is the source; local state holds only unsaved edits.
  const effectiveKind = kind ?? spec?.feeKind ?? FeeKind.UNSPECIFIED;
  const storedAmount =
    spec?.lumpSumPaise ?? spec?.perAppearancePaise ?? spec?.monthlyRetainerPaise;
  const effectiveAmount =
    amount ?? (storedAmount !== undefined ? (Number(storedAmount) / 100).toString() : "");
  const effectiveTerms = terms ?? spec?.termsNote ?? "";

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaved(false);
    const paise = effectiveAmount.trim() ? parseRupeesToPaise(effectiveAmount) : undefined;
    if (effectiveAmount.trim() && paise === undefined) {
      setError("The amount should be rupees, like 1,50,000 or 1500.50.");
      return;
    }
    if (effectiveKind !== FeeKind.NOT_SET && effectiveKind !== FeeKind.UNSPECIFIED && !paise) {
      setError("An agreed fee needs its amount.");
      return;
    }
    try {
      await save.mutateAsync({
        existing,
        spec: create(FeeArrangementSpecSchema, {
          caseId: props.caseId,
          feeKind: effectiveKind === FeeKind.UNSPECIFIED ? FeeKind.NOT_SET : effectiveKind,
          lumpSumPaise: effectiveKind === FeeKind.LUMP_SUM ? paise : undefined,
          perAppearancePaise: effectiveKind === FeeKind.PER_APPEARANCE ? paise : undefined,
          monthlyRetainerPaise: effectiveKind === FeeKind.RETAINER ? paise : undefined,
          termsNote: effectiveTerms.trim(),
        }),
      });
      setSaved(true);
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  if (arrangement.isPending) return <Loading label="Loading the arrangement…" />;
  if (arrangement.isError) {
    return (
      <ErrorState error={arrangement.error} onRetry={() => void arrangement.refetch()} />
    );
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Fee arrangement"
      className="rounded-card border border-line bg-surface p-4"
    >
      <h3 className="mb-2 text-sm font-semibold">Fee arrangement</h3>
      <Label htmlFor="fee-kind">Agreed as</Label>
      <Select
        id="fee-kind"
        value={effectiveKind}
        onChange={(e) => setKind(Number(e.target.value) as FeeKind)}
      >
        <option value={FeeKind.UNSPECIFIED} disabled>
          Pick the structure
        </option>
        {FEE_KINDS.map((k) => (
          <option key={k} value={k}>
            {feeKindLabel(k)}
          </option>
        ))}
      </Select>
      {effectiveKind !== FeeKind.NOT_SET && effectiveKind !== FeeKind.UNSPECIFIED && (
        <>
          <Label htmlFor="fee-amount">
            {effectiveKind === FeeKind.PER_APPEARANCE
              ? "Per appearance (₹)"
              : effectiveKind === FeeKind.RETAINER
                ? "Per month (₹)"
                : "Total (₹)"}
          </Label>
          <Input
            id="fee-amount"
            required
            inputMode="decimal"
            value={effectiveAmount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1,50,000"
          />
        </>
      )}
      <Label htmlFor="fee-terms">
        Terms <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input
        id="fee-terms"
        maxLength={1000}
        value={effectiveTerms}
        onChange={(e) => setTerms(e.target.value)}
        placeholder="expenses billed at actuals…"
      />
      <FormError message={error} />
      {saved && (
        <p role="status" className="mb-3 rounded-card bg-ok/10 px-3 py-2 text-sm text-ok">
          Arrangement saved.
        </p>
      )}
      <Button type="submit" variant="primary" disabled={save.isPending}>
        {save.isPending ? "Saving…" : existing ? "Update arrangement" : "Record arrangement"}
      </Button>
    </form>
  );
}

const ENTRY_KINDS: readonly LedgerEntryKind[] = [
  LedgerEntryKind.CHARGE,
  LedgerEntryKind.RECEIPT,
  LedgerEntryKind.EXPENSE,
];

function RecordEntryForm(props: { caseId: string }) {
  const record = useRecordLedgerEntry();
  const [kind, setKind] = useState<LedgerEntryKind>(LedgerEntryKind.RECEIPT);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(firmToday());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const paise = parseRupeesToPaise(amount);
    if (!paise || paise <= 0n) {
      setError("The amount should be rupees, like 50,000 or 500.50.");
      return;
    }
    try {
      await record.mutateAsync(
        create(LedgerEntrySpecSchema, {
          caseId: props.caseId,
          entryKind: kind,
          amountPaise: paise,
          date,
          note: note.trim(),
        }),
      );
      setAmount("");
      setNote("");
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Record a ledger entry"
      className="mb-3 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface p-3"
    >
      <div>
        <Label htmlFor="entry-kind">Entry</Label>
        <InlineSelect
          id="entry-kind"
          value={kind}
          onChange={(e) => setKind(Number(e.target.value) as LedgerEntryKind)}
          className="block"
        >
          {ENTRY_KINDS.map((k) => (
            <option key={k} value={k}>
              {ledgerEntryKindLabel(k)}
            </option>
          ))}
        </InlineSelect>
      </div>
      <div>
        <Label htmlFor="entry-amount">Amount (₹)</Label>
        <InlineInput
          id="entry-amount"
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="block w-36"
        />
      </div>
      <div>
        <Label htmlFor="entry-date">Date</Label>
        <InlineInput
          id="entry-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="block"
        />
      </div>
      <div className="min-w-40 flex-1">
        <Label htmlFor="entry-note">Note</Label>
        <InlineInput
          id="entry-note"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="advance by transfer…"
          className="block w-full"
        />
      </div>
      <Button type="submit" variant="primary" disabled={record.isPending}>
        {record.isPending ? "Recording…" : "Record"}
      </Button>
      {error && (
        <div className="w-full">
          <FormError message={error} />
        </div>
      )}
      <p className="w-full text-xs text-ink-muted">
        The ledger is permanent — a mistake is corrected by an offsetting entry with a note.
      </p>
    </form>
  );
}

export function CaseMoney(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const ledger = useLedgerEntries(props.caseId, page);

  return (
    <div className="mt-6 grid gap-4">
      <FeeArrangementForm caseId={props.caseId} />

      <section aria-label="Ledger">
        <h3 className="mb-2 text-sm font-semibold">Ledger</h3>
        <RecordEntryForm caseId={props.caseId} />
        {ledger.isPending && <Loading label="Loading the ledger…" />}
        {ledger.isError && (
          <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
        )}
        {ledger.isSuccess && ledger.data.items.length === 0 && (
          <EmptyState title="Nothing on the ledger yet" />
        )}
        {ledger.isSuccess && ledger.data.items.length > 0 && (
          <>
            <ul className="rounded-card border border-line bg-surface">
              {ledger.data.items.map((entry) => {
                const createdAt = entry.metadata?.createdAt;
                return (
                  <li
                    key={entry.metadata?.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 last:border-b-0"
                  >
                    <span className="w-20 text-xs text-ink-muted">
                      {formatCalendarDate(entry.spec?.date ?? "")}
                    </span>
                    <span
                      className={
                        entry.spec?.entryKind === LedgerEntryKind.RECEIPT
                          ? "rounded-card bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok"
                          : "rounded-card bg-warn-surface px-2 py-0.5 text-xs font-medium text-warn"
                      }
                    >
                      {ledgerEntryKindLabel(entry.spec?.entryKind ?? LedgerEntryKind.UNSPECIFIED)}
                    </span>
                    <span className="font-medium">{formatPaise(entry.spec?.amountPaise ?? 0n)}</span>
                    <span className="flex-1 text-xs text-ink-muted">{entry.spec?.note}</span>
                    {createdAt && (
                      <span className="text-xs text-ink-faint">
                        entered {formatInstant(timestampDate(createdAt))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <Pagination
              page={page}
              totalCount={Number(ledger.data.totalCount)}
              onPage={setPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
