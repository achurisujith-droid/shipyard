import { prisma } from '@/lib/prisma';

/** Creating organisations and putting people in them. */

export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Create an organisation with its first member as the owner. */
export async function createOrganization(input: { name: string; ownerUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: input.name.trim() },
    });
    await tx.membership.create({
      data: { organizationId: organization.id, userId: input.ownerUserId, role: 'OWNER' },
    });
    return organization;
  });
}

/** Add someone. Re-adding an existing member changes their role rather than failing. */
export async function addMember(input: {
  organizationId: string;
  userId: string;
  role: MemberRole;
}) {
  return prisma.membership.upsert({
    where: {
      organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
    },
    create: input,
    update: { role: input.role },
  });
}

/**
 * Remove someone, unless they are the last owner.
 *
 * An organisation with no owner is one nobody can administer, including to
 * appoint a new owner. It is a small check and it prevents a support ticket
 * that has no self-service answer.
 */
export async function removeMember(input: { organizationId: string; userId: string }) {
  const owners = await prisma.membership.count({
    where: { organizationId: input.organizationId, role: 'OWNER' },
  });
  const target = await prisma.membership.findUnique({
    where: {
      organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
    },
    select: { role: true },
  });

  if (!target) return { removed: false, reason: 'They are not a member.' };
  if (target.role === 'OWNER' && owners <= 1) {
    return { removed: false, reason: 'This is the only owner. Make someone else an owner first.' };
  }

  await prisma.membership.delete({
    where: {
      organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
    },
  });
  return { removed: true };
}

/** True when removing this person would leave the organisation with no owner. */
export function wouldStrandOrganization(input: {
  role: MemberRole;
  remainingOwners: number;
}): boolean {
  return input.role === 'OWNER' && input.remainingOwners <= 1;
}
