export type PrincipalId = `principal-${string}`;
export type ProfileId = `profile-${string}`;

/** Every user-associated store is addressed by both the account principal and Profile. */
export interface ProfileScope {
  readonly principal: PrincipalId;
  readonly profile: ProfileId;
}
