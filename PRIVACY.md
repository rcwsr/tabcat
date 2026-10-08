# Tabcat privacy policy

Tabcat doesn't collect anything. It has no servers, no analytics and no tracking.

## What stays on your computer

To group your tabs, Tabcat reads their titles and addresses, and for some pages the
description and keywords the page gives itself. All of this is processed by models running
inside the extension, on your computer. Your settings and a short list of recent moves (for
Undo) are kept in your Firefox profile.

## What Tabcat downloads

The first time it groups tabs, Tabcat downloads its models (about 80 MB) from Hugging Face
(huggingface.co). These are the same files for everyone. Tabcat doesn't send Hugging Face
anything about you or your tabs; like any download, Hugging Face can see your IP address.

## If you connect an AI service

This is optional and off by default. If you set up an AI service in Settings, Tabcat sends
it the titles and website names (such as `bbc.co.uk`, not the full address) of the tabs it
asks about, the description a page gives itself when its title says little, and the names of
your groups and categories with a few of their tabs' titles as examples. It also sends your
API key and any instructions you've written for it. Nothing is sent anywhere else.

- If the service runs on your own computer (such as Ollama or LM Studio), the data doesn't
  leave your computer.
- If it's somewhere else, it must use https, and Firefox asks your permission before
  anything is sent. What happens to the data then is up to that service and its own
  privacy policy.

You can stop this at any time by turning the AI service off in Settings, or by removing the
permission in `about:addons` → Tabcat → Permissions.

## Contact

Questions or problems: https://github.com/rcwsr/tabcat/issues
