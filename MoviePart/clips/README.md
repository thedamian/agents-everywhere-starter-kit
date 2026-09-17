# Generation Status

Blocked before generation: this session exposes no Astra video-generation tool,
and no local `astra` command was found. ffmpeg and ffprobe are available.
No generated clips or final video exist. Reference fidelity, audio continuity,
and actual video runtime have not been verified. No placeholder video was made.

## Locked Deliverable

- Eight shots, in order, with durations 4, 3, 3, 3, 7, 4, 3, 3 seconds: 30 seconds total.
- Vertical 9:16, with 1080x1920 at 30 fps as the assembly target.
- Astra-generated customer likeness anchored to the actual local photos.
- Toyota Tundra with body generation, trim, paint, wheels and cabin anchored to the licensed catalog photographs.
- Photographs override generic metadata: keep the photographed cabin and exterior details.
- One continuous original instrumental cue, no lyrics or narration, and restrained
  natural vehicle sound. Keep music continuous across the shot boundaries.
- Shot 8: exact tagline "Your leap starts now." and clean "Toyota" brand text.
  No dealership logo or dealership name was supplied.

## Resume Generation

Connect an authenticated Astra interface supporting reference-image-conditioned
video. Check its actual duration, aspect-ratio, reference-count and audio support;
no limits or API syntax have been assumed. Never send customer photos to a
different generator without authorization.

Submit each corresponding resolved prompt from the sibling shots directory,
attaching its listed real images, not merely mentioning the paths in text.
Keep the original face reference in every request and preserve the same wardrobe,
car and world progression. Where the reference limit is lower than the list,
prioritize face, full-body wardrobe, and the shot-relevant car angle/interior;
do not drop either the person or car reference conditioning.

Save accepted clips here as shot_01.mp4 through shot_08.mp4. Inspect
early/middle/late frames and moving footage for likeness and geometry drift;
regenerate only the failing shot. Shot 5's prompt includes the conditional split
plan. Preserve subclips and concatenate them into the seven-second shot_05.mp4.
For any other unsupported exact duration, generate enough source footage and
trim accepted action to its required duration. Do not pad with unrelated footage.

Composite exact final-shot text if necessary. Build one continuous 30-second music
cue with the specified sound progression, then mix restrained shot sound effects
under it. Do not concatenate eight unrelated generated music tracks.

## Assembly Gate

Before concatenation, normalize accepted clips to 1080x1920, square pixels,
30 fps, H.264, yuv420p, exact shot lengths and consistent audio layout. Do not
stretch landscape footage to vertical; obtain correctly framed vertical footage.
Assemble all eight clips in order using ffmpeg, retaining the uninterrupted audio
cue. Save the final file one directory above this one as back_to_the_future_ad.mp4.

Use ffprobe to verify both stream and container durations are approximately
30 seconds (within one 30 fps frame where practical), 9:16 display aspect,
correct codec/pixel format and an audio stream. Review the finished movie with
sound, including every cut and the final frame, before calling it complete.

The prepared prompts are generation inputs, not evidence of completed renders.