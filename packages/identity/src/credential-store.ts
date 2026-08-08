/**
 * The credential store port — deliberately outside the resource store
 * (the first consumer's T03 D7, now the commons rule): credentials are an
 * auth concern, not resource state, and keeping them out of the User
 * message makes a hash-in-response leak impossible by construction rather
 * than prevented by redaction.
 *
 * Writers: the operator-only SetPassword operation. Readers: Login.
 */

export interface CredentialStore {
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  getPasswordHash(userId: string): Promise<string | undefined>;
}
