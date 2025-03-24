[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/0-o0/tgbot)

- Click the deploy button
- Navigate to your new **GitHub repository &gt; Settings &gt; Secrets** and add the following secrets:

  ```yaml
  - Name: CLOUDFLARE_API_TOKEN  (should be added automatically)
  - Name: CLOUDFLARE_ACCOUNT_ID (should be added automatically)

  - Name: SECRET_TELEGRAM_API_TOKEN
  - Value: your-telegram-bot-token
  ```

- Push to `master` to trigger a deploy
