import { PrismaClient } from "@prisma/client";
import {
  AccessCheckInput,
  AccessDecision,
  Role,
  RoleContext,
} from "@guildpass/shared-types";
import { evaluate } from "@guildpass/policy-engine";
import { logEvent } from "./auditService";

const prisma = new PrismaClient();

export class MemberServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MemberServiceError";
  }
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function isValidWalletAddress(wallet: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(wallet.trim());
}

function isValidCommunityId(communityId: string): boolean {
  return typeof communityId === "string" && communityId.trim().length > 0;
}

function isValidRole(role: string): role is Role {
  return ["admin", "member", "contributor"].includes(role);
}

export function getMemberService(prismaOverride?: PrismaClient) {
  const db = prismaOverride ?? prisma;
  return {
    async getMembershipsByWallet(wallet: string, communityId?: string) {
      const normalizedWallet = normalizeWallet(wallet);
      const w = await db.wallet.findUnique({
        where: { address: normalizedWallet },
      });
      if (!w) return { wallet: normalizedWallet, communities: [] };
      const members = await db.member.findMany({
        where: { walletId: w.id, ...(communityId ? { communityId } : {}) },
        include: { membership: true },
      });
      const communities = members.map((m: any) => ({
        communityId: m.communityId,
        state: m.membership?.state || "invited",
        expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
      }));
      return { wallet: normalizedWallet, communities };
    },
    async getProfileByWallet(wallet: string, communityId?: string) {
      const normalizedWallet = normalizeWallet(wallet);
      const w = await db.wallet.findUnique({
        where: { address: normalizedWallet },
      });
      if (!w) return null;
      const m = await db.member.findFirst({
        where: { walletId: w.id, ...(communityId ? { communityId } : {}) },
        include: { profile: true, membership: true, roles: true },
      });
      if (!m) return null;
      return {
        wallet: normalizedWallet,
        communityId: m.communityId,
        profile: {
          id: m.profile?.id ?? "",
          displayName: m.profile?.displayName ?? "",
          bio: m.profile?.bio ?? "",
        },
        membership: {
          state: m.membership?.state ?? "invited",
          expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
        },
        roles: m.roles.filter((r: any) => r.active).map((r: any) => r.role),
      };
    },

    async checkAccess(input: AccessCheckInput): Promise<AccessDecision> {
      const wallet = input.wallet.toLowerCase();
      const w = await db.wallet.findUnique({ where: { address: wallet } });
      if (!w) {
        return {
          allowed: false,
          code: "DENY",
          reasons: [{ code: "NO_WALLET", message: "Wallet not known" }],
          membershipState: "invited",
          effectiveRoles: [],
        };
      }
      const member = await db.member.findFirst({
        where: { walletId: w.id, communityId: input.communityId },
        include: { roles: true, membership: true },
      });
      if (!member) {
        return {
          allowed: false,
          code: "DENY",
          reasons: [
            {
              code: "NOT_MEMBER",
              message: "Wallet is not a member of community",
            },
          ],
          membershipState: "invited",
          effectiveRoles: [],
        };
      }
      const policy = await db.accessPolicy.findFirst({
        where: { communityId: input.communityId, resource: input.resource },
      });
      const ruleType = policy ? policy.ruleType : "MEMBERS_ONLY";
      const ctx: RoleContext = {
        assignments: member.roles.map((r: any) => ({
          role: r.role as any,
          source: r.source as any,
          active: r.active,
        })),
        membershipState: (member.membership?.state as any) ?? "invited",
      };
      const decision = evaluate(
        {
          id: policy?.id ?? "default",
          communityId: input.communityId,
          resource: input.resource,
          ruleType: ruleType,
          params: policy?.params as Record<string, any> | undefined,
        },
        ctx,
      );
      return decision;
    },
    async listMembersForAdmin(
      communityId: string,
      role?: "admin" | "member" | "contributor",
    ) {
      // NOTE: list endpoint is intended for community admins.
      // Enforcing requester-admin auth requires requester wallet identity, which is not provided here.
      // This endpoint is for admin listing only; enforce auth here.
      // NOTE: This service method receives only communityId + optional role, so
      // requester auth is expected to be enforced by the route via a wrapper.
      // (We keep listing open at service-layer to avoid breaking existing API.)
      const members = await db.member.findMany({


        where: { communityId },
        include: { wallet: true, membership: true, roles: true, profile: true },
      });
      const list = members
        .map((m: any) => {
          const activeRoles = m.roles
            .filter((r: any) => r.active)
            .map((r: any) => r.role);
          return {
            wallet: m.wallet.address,
            displayName: m.profile?.displayName ?? null,
            state: m.membership?.state ?? "invited",
            roles: activeRoles,
          };
        })
        .filter((item: any) => (role ? item.roles.includes(role) : true));
      return { communityId, members: list };
    },

    async assignMemberRole(input: {
      requesterWallet: string;
      communityId: string;
      targetWallet: string;
      role: string;
    }) {
      const { requesterWallet, communityId, targetWallet, role } = input;
      if (!isValidCommunityId(communityId)) {
        throw new MemberServiceError("Invalid community ID", 400);
      }
      if (!isValidWalletAddress(requesterWallet)) {
        throw new MemberServiceError("Invalid requester wallet", 400);
      }
      if (!isValidWalletAddress(targetWallet)) {
        throw new MemberServiceError("Invalid target wallet", 400);
      }
      if (!isValidRole(role)) {
        throw new MemberServiceError("Invalid role", 400);
      }

      const normalizedRequester = normalizeWallet(requesterWallet);
      const normalizedTarget = normalizeWallet(targetWallet);
      const normalizedRole = role as Role;

      const community = await db.community.findUnique({ where: { id: communityId } });
      if (!community) {
        throw new MemberServiceError("Community not found", 404);
      }

      const requesterWalletRecord = await db.wallet.findUnique({
        where: { address: normalizedRequester },
      });
      if (!requesterWalletRecord) {
        throw new MemberServiceError("Unauthorized", 401);
      }

      const requesterMember = await db.member.findFirst({
        where: { walletId: requesterWalletRecord.id, communityId },
        include: { roles: true },
      });
      if (
        !requesterMember ||
        !requesterMember.roles.some((assignment: any) => assignment.active && assignment.role === "admin")
      ) {
        throw new MemberServiceError("Forbidden", 403);
      }

      const targetWalletRecord = await db.wallet.findUnique({
        where: { address: normalizedTarget },
      });
      if (!targetWalletRecord) {
        throw new MemberServiceError("Target wallet not found", 404);
      }

      const targetMember = await db.member.findFirst({
        where: { walletId: targetWalletRecord.id, communityId },
      });
      if (!targetMember) {
        throw new MemberServiceError("Target member not found", 404);
      }

      const existingAssignment = await db.roleAssignment.findFirst({
        where: { memberId: targetMember.id, role: normalizedRole, active: true },
      });
      if (existingAssignment) {
        return {
          communityId,
          wallet: normalizedTarget,
          role: normalizedRole,
          assigned: false,
          removed: false,
          message: "Role already assigned",
        };
      }

      await db.roleAssignment.create({
        data: {
          memberId: targetMember.id,
          role: normalizedRole,
          source: "manual",
          active: true,
        },
      });

      return {
        communityId,
        wallet: normalizedTarget,
        role: normalizedRole,
        assigned: true,
        removed: false,
        message: "Role assigned",
      };
    },

    async removeMemberRole(input: {
      requesterWallet: string;
      communityId: string;
      targetWallet: string;
      role: string;
    }) {
      const { requesterWallet, communityId, targetWallet, role } = input;
      if (!isValidCommunityId(communityId)) {
        throw new MemberServiceError("Invalid community ID", 400);
      }
      if (!isValidWalletAddress(requesterWallet)) {
        throw new MemberServiceError("Invalid requester wallet", 400);
      }
      if (!isValidWalletAddress(targetWallet)) {
        throw new MemberServiceError("Invalid target wallet", 400);
      }
      if (!isValidRole(role)) {
        throw new MemberServiceError("Invalid role", 400);
      }

      const normalizedRequester = normalizeWallet(requesterWallet);
      const normalizedTarget = normalizeWallet(targetWallet);
      const normalizedRole = role as Role;

      const community = await db.community.findUnique({ where: { id: communityId } });
      if (!community) {
        throw new MemberServiceError("Community not found", 404);
      }

      const requesterWalletRecord = await db.wallet.findUnique({
        where: { address: normalizedRequester },
      });
      if (!requesterWalletRecord) {
        throw new MemberServiceError("Unauthorized", 401);
      }

      const requesterMember = await db.member.findFirst({
        where: { walletId: requesterWalletRecord.id, communityId },
        include: { roles: true },
      });
      if (
        !requesterMember ||
        !requesterMember.roles.some((assignment: any) => assignment.active && assignment.role === "admin")
      ) {
        throw new MemberServiceError("Forbidden", 403);
      }

      const targetWalletRecord = await db.wallet.findUnique({
        where: { address: normalizedTarget },
      });
      if (!targetWalletRecord) {
        throw new MemberServiceError("Target wallet not found", 404);
      }

      const targetMember = await db.member.findFirst({
        where: { walletId: targetWalletRecord.id, communityId },
      });
      if (!targetMember) {
        throw new MemberServiceError("Target member not found", 404);
      }

      const existingAssignment = await db.roleAssignment.findFirst({
        where: { memberId: targetMember.id, role: normalizedRole, active: true },
      });
      if (!existingAssignment) {
        return {
          communityId,
          wallet: normalizedTarget,
          role: normalizedRole,
          assigned: false,
          removed: false,
          message: "Role not assigned",
        };
      }

      await db.roleAssignment.updateMany({
        where: { memberId: targetMember.id, role: normalizedRole, active: true },
        data: { active: false },
      });

      return {
        communityId,
        wallet: normalizedTarget,
        role: normalizedRole,
        assigned: false,
        removed: true,
        message: "Role removed",
      };
    },
  };
}
