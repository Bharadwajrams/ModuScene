/**
 * Module Builder V1.1 — Webcam Source
 *
 * Owns the webcam lifecycle: getUserMedia, video element stream,
 * frame capture for MediaPipe. One webcam source, one pipeline.
 *
 * Source of truth: Doc 04 §10, Doc 04 §16, D-019
 */

// ─── Webcam Source ───────────────────────────────────────

export class WebcamSource {
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private isRunning = false;

  /**
   * Start the webcam stream and attach it to a video element.
   */
  async start(videoElement: HTMLVideoElement): Promise<boolean> {
    if (this.isRunning) return true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
        },
        audio: false,
      });

      this.videoElement = videoElement;
      videoElement.srcObject = this.stream;

      await new Promise<void>((resolve, reject) => {
        videoElement.onloadedmetadata = () => {
          videoElement.play()
            .then(() => resolve())
            .catch(reject);
        };
        videoElement.onerror = () => reject(new Error('Video element error'));
      });

      this.isRunning = true;
      console.log('[WebcamSource] Started');
      return true;
    } catch (error) {
      console.error('[WebcamSource] Failed to start:', error);
      return false;
    }
  }

  /**
   * Stop the webcam stream.
   */
  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
    this.isRunning = false;
    console.log('[WebcamSource] Stopped');
  }

  /**
   * Get the current video element for frame processing.
   */
  getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  /**
   * Check if the webcam is running.
   */
  get running(): boolean {
    return this.isRunning;
  }
}
