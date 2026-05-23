import { Type, type FunctionDeclaration, type FunctionCall } from "@google/genai";
import type { User } from "../session/User";
import { isMode, type Mode } from "./modes";

/**
 * Tools the AI can call.
 *
 * Each tool is a function declaration Gemini Live sees + a server-side
 * handler that actually performs the side effect and returns a structured
 * result. Gemini then incorporates that result into the spoken reply
 * (e.g. "Okay, camera is on now.").
 *
 * Design notes:
 * - Names are lower_snake_case (Gemini convention).
 * - Every tool returns `{ success, message, state }` so Gemini has both
 *   confirmation and current state in one response.
 * - This is a visual-aid app: the wearer can't see the phone. Tools must
 *   always succeed-or-explain — never silently fail.
 */

/** What every tool returns to Gemini. */
export interface ToolResult {
  success: boolean;
  /** Short message Gemini may quote when confirming verbally. */
  message: string;
  /** Always include current state so Gemini's reply is in sync. */
  state: ReturnType<User["state"]["snapshot"]>;
}

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "set_camera",
    description:
      "Turn the camera (livestream) on or off. The wearer can't see the phone, " +
      "so call this whenever they ask to turn the camera on/off or whenever " +
      "you need to see and the camera is off.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        on: {
          type: Type.BOOLEAN,
          description: "true to turn the camera on, false to turn it off.",
        },
      },
      required: ["on"],
    },
  },
  {
    name: "set_mode",
    description:
      "Switch the AI mode. passive = ambient narration only when meaningful; " +
      "outdoor = navigation/hazard priority; auto = adapts to scene; " +
      "active = direct Q&A.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          description: "One of: passive, active, outdoor, auto.",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "get_state",
    description:
      "Read the current session state (camera, mode, stream status). Call " +
      "this when the wearer asks about how things are set — e.g. \"is the " +
      "camera on?\", \"what mode are you in?\".",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

/**
 * Execute one tool call from Gemini and return the result to feed back.
 */
export async function executeTool(
  user: User,
  call: FunctionCall,
): Promise<ToolResult> {
  const args = (call.args ?? {}) as Record<string, unknown>;
  console.log(`🛠  Tool call: ${call.name}(${JSON.stringify(args)}) for ${user.userId}`);

  switch (call.name) {
    case "set_camera": {
      const on = Boolean(args.on);
      try {
        if (on) {
          if (user.state.snapshot().cameraOn) {
            return ok("Camera is already on.", user);
          }
          await user.liveStream.start();
          return ok("Camera is on.", user);
        } else {
          if (!user.state.snapshot().cameraOn && user.state.snapshot().streamStatus === "inactive") {
            return ok("Camera is already off.", user);
          }
          await user.liveStream.stop();
          return ok("Camera is off.", user);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return fail(`Couldn't ${on ? "start" : "stop"} the camera: ${msg}`, user);
      }
    }

    case "set_mode": {
      const mode = args.mode;
      if (!isMode(mode)) {
        return fail(`Unknown mode: ${String(mode)}. Valid modes: passive, active, outdoor, auto.`, user);
      }
      try {
        await user.agent.setMode(mode as Mode, "tool");
        return ok(`Switched to ${mode} mode.`, user);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return fail(`Couldn't switch mode: ${msg}`, user);
      }
    }

    case "get_state": {
      const s = user.state.snapshot();
      const human =
        `Camera is ${s.cameraOn ? "on" : "off"}` +
        ` (stream ${s.streamStatus}); mode is ${s.mode}.`;
      return ok(human, user);
    }

    default:
      return fail(`Unknown tool: ${call.name}`, user);
  }
}

function ok(message: string, user: User): ToolResult {
  return { success: true, message, state: user.state.snapshot() };
}

function fail(message: string, user: User): ToolResult {
  return { success: false, message, state: user.state.snapshot() };
}
