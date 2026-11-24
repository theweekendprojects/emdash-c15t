/**
 * Types for what EmDash passes to the plugin's routes and hooks. Built from the types EmDash exports, so a
 * change in EmDash shows up as a compile error here rather than a runtime surprise.
 */
import type { PluginContext } from "emdash";

/**
 * What a trusted route handler receives: the plugin context, plus the validated input (`input`) and the
 * original request (`request`). The request is a real `Request`, so `headers` is a `Headers` object.
 */
export type RouteContext<TInput = unknown> = PluginContext & {
	input: TInput;
	request: Request;
};
