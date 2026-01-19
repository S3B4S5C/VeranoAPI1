import { SetMetadata } from '@nestjs/common';
export const PROJECT_ROLES_KEY = 'projectRoles';
export const RequireProjectRole = (...roles: Array<'OWNER' | 'EDITOR' | 'READER'>) =>
  SetMetadata(PROJECT_ROLES_KEY, roles);
