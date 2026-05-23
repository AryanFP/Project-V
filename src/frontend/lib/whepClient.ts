/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) client.
 *
 * Mirrors the sibling Livestreamer app's WHEPClient
 * (Livestreamer/src/frontend/src/components/WHEPClient.ts), which is
 * battle-tested against Cloudflare Stream's WHEP endpoint. Key behaviors
 * that this version inherits:
 *
 *   - `bundlePolicy: "max-bundle"` — ensures video + audio are bundled in
 *     a single transport, which is what Cloudflare's WHEP answer expects.
 *     Without it, SDP negotiation can succeed but no media flows.
 *
 *   - 1 second ICE-gathering cap (not 2s) — matches Livestreamer; faster
 *     to first SDP POST without sacrificing candidate coverage.
 *
 *   - **Retry loop with 5 second backoff** on a non-201, non-405 WHEP
 *     POST response. Cloudflare occasionally returns a 5xx for ~5s after
 *     the cloud-side stream is reported active; without retry the user
 *     just sees a black box. With retry the player connects once the
 *     ingest stabilizes.
 *
 *   - Stops on HTTP 405 (invalid WHEP URL — no point retrying).
 *
 *   - Stops if the peer connection is closed (caller called .close()).
 *
 * No external dependency needed; this is the whole protocol.
 */

export interface WhepSession {
  /** Tear down the peer connection and stop playback. */
  close: () => void;
}

/**
 * Connect to a WHEP playback URL and attach the incoming media to a
 * <video> element.
 *
 * @param whepUrl  The WHEP playback URL (the cloud's `webrtcUrl`).
 * @param video    The target <video> element.
 * @returns A session handle; call `.close()` to stop.
 */
export async function playWhepStream(
  whepUrl: string,
  video: HTMLVideoElement,
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    // Required for Cloudflare WHEP: bundle audio + video on one transport.
    bundlePolicy: "max-bundle",
  });

  // Egress only — we want video. We declare BOTH transceivers because
  // Cloudflare publishes audio + video tracks; an offer that omits the
  // audio m-line confuses negotiation and the video never reaches the
  // <video> element (black frame). We negotiate audio for the protocol's
  // sake and just drop the incoming audio track on the floor.
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const remoteStream = new MediaStream();
  let attached = false;

  pc.ontrack = (event) => {
    if (event.track.kind !== "video") {
      // Stop the audio track immediately so the browser doesn't waste any
      // work decoding it. We declared the transceiver, that's enough.
      event.track.stop();
      return;
    }
    // Add the video track exactly once — Cloudflare sometimes fires
    // ontrack twice for the same kind across renegotiations.
    const hasVideo = remoteStream.getTracks().some((t) => t.kind === "video");
    if (!hasVideo) {
      remoteStream.addTrack(event.track);
    }
  };

  // Attach the stream to the <video> only once the connection is up.
  // (Livestreamer's pattern.) Attaching too early gives the element a
  // MediaStream that never produces frames if SDP fails.
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected" && !attached) {
      attached = true;
      video.srcObject = remoteStream;
    }
  });

  // Kick off the first negotiation. The negotiation function runs its own
  // retry loop, so we don't await it here — fire-and-forget. The session
  // handle below can be closed at any time to abort.
  void negotiateConnectionWithClientOffer(pc, whepUrl);

  return {
    close: () => {
      pc.ontrack = null;
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      try {
        video.srcObject = null;
      } catch {
        /* element may already be detached */
      }
      remoteStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* fine */
        }
      });
    },
  };
}

/**
 * Build a local SDP offer, POST it to the WHEP endpoint, apply the answer.
 *
 * Retries on transient errors (anything that isn't 201 Created or 405
 * Method Not Allowed) with a 5 second backoff. Stops when:
 *   - the WHEP server returns 201 (success — answer applied)
 *   - the WHEP server returns 405 (URL invalid; no point retrying)
 *   - the peer connection is closed by the caller
 */
async function negotiateConnectionWithClientOffer(
  pc: RTCPeerConnection,
  endpoint: string,
): Promise<string | null> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to finish (or 1 second, whichever is first).
  // Matches Livestreamer's WHEPClient timing. 2s was slower with no
  // benefit — most candidates arrive in <300ms anyway.
  const localDescription = await new Promise<RTCSessionDescription | null>(
    (resolve) => {
      const t = setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve(pc.localDescription);
      }, 1000);
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve(pc.localDescription);
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
    },
  );

  if (!localDescription) {
    console.error("[WHEPClient] Failed to gather ICE candidates for offer");
    return null;
  }

  // Retry loop — keep posting until we get a 201, a 405, or the caller
  // closes the connection. Backoff is fixed at 5 seconds (Livestreamer's
  // value). Cloudflare's ingest typically stabilizes within one retry.
  while (pc.connectionState !== "closed") {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        headers: { "content-type": "application/sdp" },
        body: localDescription.sdp,
      });

      if (response.status === 201) {
        const answerSdp = await response.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        return response.headers.get("Location");
      } else if (response.status === 405) {
        console.error("[WHEPClient] Invalid WHEP URL (HTTP 405)");
        return null;
      } else {
        const errBody = await response.text().catch(() => "");
        console.warn(
          `[WHEPClient] SDP negotiation error: HTTP ${response.status} ${errBody.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(
        `[WHEPClient] WHEP POST failed: ${err instanceof Error ? err.message : String(err)} — retrying`,
      );
    }

    // Backoff before next attempt. If the caller .close()d the connection
    // during the sleep we bail next loop iteration.
    await new Promise((r) => setTimeout(r, 5000));
  }

  return null;
}
