import { register } from "./registry";

export const cfgProfilesItems = register({
	id: "profiles.items",
	type: "record",
	default: {} as Record<string, unknown>,
});

export const cfgProfilesActive = register({ id: "profiles.active", type: "string", default: "" });
