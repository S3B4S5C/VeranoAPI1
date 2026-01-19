import { SetMetadata } from '@nestjs/common';
export const WORKSPACE_ROLES_KEY = 'workspaceRoles';
export const RequireWorkspaceRole = (...roles: Array<'OWNER'|'ADMIN'|'MEMBER'>) =>
  SetMetadata(WORKSPACE_ROLES_KEY, roles);
