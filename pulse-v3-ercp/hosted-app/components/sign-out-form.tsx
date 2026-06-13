import { signOutAction } from "@/lib/auth/actions";

export function SignOutForm() {
  return (
    <form action={signOutAction}>
      <button className="button" type="submit">
        Sign out
      </button>
    </form>
  );
}
