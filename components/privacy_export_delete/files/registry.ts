/**
 * Every table that holds personal data, and what happens to it on erasure.
 *
 * This file is yours to fill in, and it is the part that decides whether the
 * whole component works. There is no way to detect a table you forgot to list —
 * so listing one is a step, not a suggestion.
 *
 * The lesson behind the shape: a database cascade only reaches tables joined by
 * a foreign key. Anything written loosely — an events table keyed by an id with
 * no relation, an archive, a snapshot — survives a delete that looks complete.
 * That is exactly the kind of table that holds a transcript or an old copy of a
 * profile, and exactly the kind nobody remembers.
 */

export type ErasureAction =
  /** Delete the rows outright. */
  | 'delete'
  /** Keep the row, blank the personal fields. For anything an invoice refers to. */
  | 'anonymise'
  /**
   * Keep it as it is. Only for records you are legally required to retain —
   * and the reason has to be written down.
   */
  | 'retain';

export interface PersonalDataTable {
  /** The Prisma model name. */
  model: string;
  /** In the founder's words: what is in here. */
  describes: string;
  /** The column linking rows to a person. */
  subjectField: string;
  /** Included in an export request. */
  exportable: boolean;
  onErasure: ErasureAction;
  /** Fields blanked when the action is `anonymise`. */
  anonymiseFields?: string[];
  /** Required when the action is `retain`. Says which obligation. */
  retentionReason?: string;
}

export const PERSONAL_DATA: PersonalDataTable[] = [
  {
    model: 'User',
    describes: 'Account details — name, email address, when they signed up.',
    subjectField: 'id',
    exportable: true,
    onErasure: 'anonymise',
    anonymiseFields: ['email', 'name', 'passwordHash'],
  },
  {
    model: 'Session',
    describes: 'Sign-in sessions, including the device and address used.',
    subjectField: 'userId',
    exportable: false,
    onErasure: 'delete',
  },
  {
    model: 'AuditEvent',
    describes: 'The record of what was done and by whom.',
    subjectField: 'actorUserId',
    exportable: true,
    onErasure: 'retain',
    retentionReason:
      'The audit log is the evidence that erasure itself was carried out. Deleting it would remove the proof.',
  },
  // Add your own tables here. Every one of them.
];
