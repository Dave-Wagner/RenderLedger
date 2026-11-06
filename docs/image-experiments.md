# Image experiments

Open **Image studio**. Use the device picker for an individual run or expand **Batch targets** and select the targets to run sequentially. NPU is available for local reference runs. The app uses the same prompt, seed, steps, strength, and prepared reference for every target in the batch. **Stop active workload** cancels the active request and stops the remaining batch in that tab. Keep the tab open until the batch finishes.

The dashboard and CLI save started image runs in `npu-lab.sqlite3` in the project folder. Set `NPU_LAB_DB` to use a different database file. This includes failed and interrupted runs. History stores the submitted settings, reference, output, error, and timings. Filter by prompt, target, model, or status. Select multiple saved runs to compare them side by side. Back up the SQLite file with the app closed to keep your history. Images can grow the database over time.



Earlier Colab results remain in saved history. The notebook and bridge are in the [Colab archive](../archive/colab/README.md).
