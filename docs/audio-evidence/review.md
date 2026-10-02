Concrete review findings and fixes during this task:
- Limiter preceded volume, so turning down playback retained gain modulation.
- Sample ceiling did not bound reconstructed peaks; Genesis output was +0.2 dBTP.
- First 48-tap detector passed a short oracle but failed the stronger 8193-tap
  32x reference near Nyquist. The acceptance threshold was retained.
- Default browser compressor fallback needed a different label and extra headroom.
- Opus container gain must not be applied again after Chromium decoding.
- Missing album evidence must not silently receive per-track gain.
- Source catalog count changed during work, requiring conditional metadata writes.
- Complete album claims require exact snapshot membership and invalidate on additions.
