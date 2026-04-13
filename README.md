# Sparkler

Upload Gaussian splats from the command line and get a shareable web viewer.

## Quick Start

Run this in a new empty directory:

```bash
curl -fsSL https://raw.githubusercontent.com/61cygni/sparkler/main/public/setup.sh -o setup.sh
bash setup.sh
./bin/sparkler login
./bin/sparkler host ./myscan.spz
```

The installer keeps everything in the current directory by default:

- `./bin/sparkler`
- `./.sparkler`
- `./.config/sparkler`
- `./.npm-cache`

Delete the folder and the local Sparkler install is gone too.

## Common Commands

```bash
./bin/sparkler login
./bin/sparkler logout
./bin/sparkler host ./myscan.spz
./bin/sparkler list --verbose
./bin/sparkler view <sceneId>
./bin/sparkler audio list <sceneId>
./bin/sparkler audio add-background <sceneId> ./music.mp3
./bin/sparkler audio add-positional <sceneId> ./speaker.ogg --position 0,1.5,-2
./bin/sparkler embed-snippet <sceneId>
./bin/sparkler del <sceneId>
```

## Notes

- `sparkler login` opens the browser and saves your CLI session locally.
- `sparkler logout` removes the local CLI token and signs out the browser session when possible.
- `sparkler view <sceneId>` opens the hosted scene page in your browser.
- `sparkler audio add-background` replaces the scene's single looping background track.
- `sparkler audio add-positional` adds a spatial audio source at a world position.
- `sparkler audio set <sceneId> background|<audioId>` updates volume, loop, and positional settings.
- `sparkler audio remove <sceneId> background|<audioId>` removes a background or positional track.
- `sparkler embed-snippet <sceneId>` prints iframe embed HTML.
- If your account is pending approval, uploads and scene-management commands will stay blocked until an admin approves you.

## For Developers

Most people should only need the CLI quickstart above.

If you want the full project setup, Convex/Tigris/Clerk configuration, local development workflow, and deployment details, see [`DEVELOPERS.md`](./DEVELOPERS.md).
