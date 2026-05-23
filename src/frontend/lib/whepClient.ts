/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) client.
 *
 * WHEP playback is simple: create a recvonly RTCPeerConnection, POST the
 * local SDP offer to the WHEP URL, apply the SDP answer that comes back.
 * Cloudflare Stream then pushes the glasses' video over WebRTC — sub-second.
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
  });

  // Egress only — we want video. We declare BOTH transceivers because
  // Cloudflare publishes both audio + video tracks; an offer that omits the
  // audio m-line confuses negotiation and the video never reaches the
  // <video> element (you get a black frame). We negotiate audio for the
  // protocol's sake and just drop the incoming audio track on the floor.
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  // Only attach the VIDEO track to the element — never the audio track.
  // This is what makes the stream effectively "video-only" for our app.
  const remoteStream = new MediaStream();
  pc.ontrack = (event) => {
    if (event.track.kind !== "video") {
      // Stop the audio track immediately so the browser doesn't waste any
      // work decoding it. We declared the transceiver, that's enough.
      event.track.stop();
      return;
    }
    remoteStream.addTrack(event.track);
    video.srcObject = remoteStream;
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to finish so the offer SDP is complete.
  await waitForIceGathering(pc);

  const response = await fetch(whepUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription?.sdp ?? offer.sdp ?? "",
  });

  if (!response.ok) {
    pc.close();
    throw new Error(`WHEP request failed: HTTP ${response.status}`);
  }

  const answerSdp = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    close: () => {
      pc.ontrack = null;
      pc.close();
      video.srcObject = null;
    },
  };
}

/** Resolve once ICE candidate gathering completes (or after a short cap). */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", check);
    // Don't wait forever — most candidates arrive within ~1s.
    const timer = setTimeout(done, 2000);
  });
}
