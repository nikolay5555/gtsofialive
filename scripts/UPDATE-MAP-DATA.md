# Обновяване на статичните данни за картата

## Препоръчителен начин: ръчно от сайта на GitHub

Проектът включва GitHub Actions workflow, който се стартира само при ръчна заявка. **Няма `cron` и няма автоматично обновяване по график.**

1. Отвори хранилището `GTSOFIA Live` в сайта на GitHub.
2. Качи/commit-ни текущите промени, включително `.github/workflows/update-map-data.yml`, ако още не е в хранилището.
3. Отвори раздела **Actions**.
4. Вляво избери **„Обновяване на статичните данни на картата“**.
5. Натисни **Run workflow**, избери клона, който искаш да обновиш, и потвърди.
6. Отвори изпълнението, за да видиш логовете и резултата.

Workflow-ът вече изтегля отделните файлове, от които се нуждае картата, от директорията `data/` на основния проект GTSofia: `metadata.json`, `routes.json`, `stops.json`, `directions.json` и `shapes.json`. Не се изтеглят календарът, пълните trip таблици или разписанията, защото те не са нужни за геометрията на картата. Преобразувателят ги обединява в компактния `data/transport-map.json`, проверява резултата и commit-ва само този файл, ако има промени.

Ако изходните данни са невалидни, непълни или по-стари от текущите, workflow-ът спира и съществуващият файл не се заменя. Няма автоматичен график — обновяването остава ръчно.

### Ако GitHub откаже push

Workflow-ът изисква разрешение `contents: write`. Ако организацията/настройките на хранилището не позволяват запис чрез `GITHUB_TOKEN`, провери **Settings → Actions → General → Workflow permissions** и разреши workflow-ите да имат нужните права за запис, ако това е позволено за хранилището.

## Алтернатива: стартиране локално

От главната директория на GTSOFIA Live:

```bash
python scripts/update-map-data.py
```

За да използваш модулните данни от локално копие на основния проект GTSofia, подай директорията `data/`:

```bash
python scripts/update-map-data.py --source ../gtsofia-main/data
```

Може да подадеш и корена на GTSofia:

```bash
python scripts/update-map-data.py --source ../gtsofia-main
```

Старият монолитен `transport.json` все още се поддържа като вход за обратна съвместимост, ако разполагаш с архивна версия:

```bash
python scripts/update-map-data.py --source ../gtsofia-main/data/transport.json
```

Скриптът обновява само `data/transport-map.json`. Не променя `route-catalog.json`, `stop-catalog.json`, `depot-rules.json` или `expected-models.json`.
