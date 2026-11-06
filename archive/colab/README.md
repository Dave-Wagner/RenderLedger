# Archived Colab experiment

This folder preserves the notebook, tunnel client, and original setup notes. The dashboard connection described below is historical. Existing Colab results remain in saved image history.

1. Open Google Colab, select **File → Upload notebook**, and upload [npu-lab-colab.ipynb](npu-lab-colab.ipynb). Save a copy if you want to keep it in Drive.
2. Choose a GPU runtime under **Runtime → Change runtime type**. Run the dependency and model cells, then run the sample in the notebook to verify the model loads.
3. If your runtime permits using an external interface, run the optional dashboard bridge cell. Copy its temporary URL and generated pairing token into **Image studio → Connect Colab**. Keep the notebook open. Select **Colab** for an individual run or check it in **Batch targets**. The dashboard shows **Colab active** during that job.
4. Stop the bridge cell to close the tunnel. Restarting the bridge issues a new URL and token. If the dashboard stops polling, the notebook cancels at a later denoising step after the lease expires.

The notebook uses a public model download and an accountless Cloudflare Quick Tunnel. It needs no Google Cloud project, service account, cloud API key, or ngrok account. Treat the notebook pairing token like a password. Clear the bridge cell output before sharing a notebook copy. If a run reaches a Colab limit or the tunnel disconnects, the local history records the error.

Google restricts using a free Colab runtime primarily through an external UI. Run the generation cell inside the notebook on those runtimes. The optional bridge is for a runtime where external access is allowed. [Colab FAQ](https://research.google.com/colaboratory/faq.html)

The default model cache uses temporary runtime disk. It uses no Drive quota unless you explicitly mount Drive and change the cache path. A Drive cache can avoid redownloading weights, but it consumes space shared with the rest of the account. Check your actual remaining quota before switching, and use a dedicated cache folder so it is easy to identify and remove later. The setup cell checks filesystem free space as a rough preflight. Drive account quota may differ from the filesystem reading.

SDXL Turbo model weights are governed by the upstream license. [Model card](https://huggingface.co/stabilityai/sdxl-turbo)

