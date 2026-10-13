# Обновяване на статичните данни за картата

## Препоръчителен начин: ръчно от сайта на GitHub

Проектът включва GitHub Actions workflow, който се стартира само при ръчна заявка. **Няма `cron` и няма автоматично обновяване по график.**

1. Отвори хранилището `GTSOFIA Live` в сайта на GitHub.
2. Ако workflow файлът още не е в хранилището, качи/commit-ни `.github/workflows/update-map-data.yml` заедно с останалите промени.
3. Отвори раздела **Actions**.
4. Вляво избери **„Обновяване на статичните данни на картата“**.
5. Натисни **Run workflow**, избери клона, който искаш да обновиш, и потвърди с бутона **Run workflow**.
6. Отвори стартираното изпълнение, за да видиш логовете и резултата.

Workflow-ът изтегля последно публикувания `data/transport.json` от основния проект GTSofia, преобразува данните, проверява резултата и commit-ва само `data/transport-map.json`, ако действително има промени. Ако проверката се провали или източникът е по-стар от текущите данни, workflow-ът спира и съществуващият файл не се заменя.

### Ако GitHub откаже push

Workflow-ът изисква разрешение `contents: write`. Ако организацията/настройките на хранилището не позволяват запис чрез `GITHUB_TOKEN`, провери **Settings → Actions → General → Workflow permissions** и разреши workflow-ите да имат нужните права за запис, ако това е позволено за хранилището.

## Алтернатива: стартиране локално

От главната директория на проекта:

```bash
python scripts/update-map-data.py
```

За да използваш локален `data/transport.json` от основния проект GTSofia:

```bash
python scripts/update-map-data.py --source ../gtsofia-main/data/transport.json
```

Скриптът обновява само `data/transport-map.json`. Не променя `route-catalog.json`, `stop-catalog.json`, `depot-rules.json` или `expected-models.json`.
