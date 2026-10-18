# Alder

Alder files pictures and videos you already have into kink folders. It runs on your computer. The files are not uploaded. This is for an adult collection. It will not sort anything labeled as a minor.

The first sort downloads a general picture model, about 200 MB, from Hugging Face. After that, sorting works offline. The model is CLIP, so it is useful for broad categories and weak on subtle ones. A file that does not clear the slider goes to Unsorted.

```
Collection/
  Kinks/
    Oral/
      img_Oral_NSFW_1.jpg
      videos/
        vid_Oral_NSFW_1.mp4
    Unsorted/
      videos/
  misc/
```

One file goes to one kink, the closest match above the slider. With Sort videos on, five frames are scored and one matching frame is enough. With it off, every video goes to `Kinks/Unsorted/videos`. Other files go to `misc`.

Set the collection before sorting. The sort then asks for the folder that holds the new files. A kink folder that already exists is kept, and new files take the next number.

## Desktop app

Download the build from the [v0.1.1 release](https://github.com/delusionalcookie/Alder/releases/tag/v0.1.1).

- **Windows:** unzip and open `Alder.exe`. If SmartScreen appears, choose More info, then Run anyway. The app is not signed.
- **Linux:** open the AppImage. If it does not start, allow the file to run as a program.

The list of kinks is yours. One per line. The examples are a starting point, not a limit. Turn on **Skip files already named** so a later run does not score `img_Oral_NSFW_1` again.

Alder includes an LGPL FFmpeg build so it can read video formats the player itself cannot. FFmpeg is a separate program and is only used when Sort videos is on.
