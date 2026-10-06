import { AccountPolicies, matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth/policy";
import type { AuthAccountSelector, StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { cfgAuthAccountPolicies } from "../../config/model-settings";
import type { Settings } from "../../config/settings";

export async function setAccountPriority(
	settings: Settings,
	provider: string,
	credentials: StoredAuthCredential[],
	credentialId: number,
	priority: number | undefined,
): Promise<void> {
	if (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 1)) {
		throw new Error("Priority must be a positive integer or Auto");
	}
	const credential = credentials.find(row => row.id === credentialId)?.credential;
	if (!credential) throw new Error("The selected account is no longer stored");
	if (credential.type !== "oauth") throw new Error("Priority is available only for OAuth accounts");
	const account: AuthAccountSelector = {
		...(credential.email ? { email: credential.email } : {}),
		...(credential.accountId ? { accountId: credential.accountId } : {}),
		...(credential.projectId ? { projectId: credential.projectId } : {}),
		...(credential.orgId ? { orgId: credential.orgId } : {}),
	};
	if (!account.email && !account.accountId && !account.projectId) {
		throw new Error("This account has no stable identity for a priority policy");
	}
	await settings.flush();
	const source = cfgAuthAccountPolicies.provenance(settings);
	if (source !== "global" && source !== "default") {
		throw new Error(`Account policies are controlled by ${source} settings; edit that source instead`);
	}
	const previous = cfgAuthAccountPolicies.get(settings);
	const existing = previous.findIndex(
		policy => policy.provider === provider && matchesAuthAccountSelector(policy.account, credential),
	);
	const next = [...previous];
	if (existing >= 0) {
		const { priority: _previousPriority, ...policy } = next[existing]!;
		if (priority !== undefined) next[existing] = { ...policy, priority };
		else if (policy.reservePct !== undefined) next[existing] = policy;
		else next.splice(existing, 1);
	} else if (priority !== undefined) {
		next.push({ provider, account, priority });
	}
	new AccountPolicies(next, undefined).validateFor(
		provider,
		credentials.map(row => row.credential),
	);
	if (Bun.deepEquals(previous, next)) return;
	cfgAuthAccountPolicies.set(settings, next);
	try {
		await settings.flush();
	} catch (error) {
		if (Bun.deepEquals(cfgAuthAccountPolicies.get(settings), next)) {
			if (source === "default") cfgAuthAccountPolicies.unset(settings);
			else cfgAuthAccountPolicies.set(settings, previous);
		}
		throw error;
	}
	if (!Bun.deepEquals(cfgAuthAccountPolicies.get(settings), next)) {
		throw new Error("Account policies changed while saving; reopen /accounts to see the current priorities");
	}
}
