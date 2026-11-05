# João

**Un solo escritorio para GNOME Shell.**
Creado y diseñado por **Frank Molina**.

João reúne en una sola extensión las escenas de ventanas y un lanzador a pantalla completa que sustituye a la barra superior de GNOME.

## Funciones

- **Escenas de ventanas**: la escena activa en el centro y las demás en una franja lateral, con su vista previa. Una app minimizada se cierra desde su miniatura.
- **Lanzador a pantalla completa**: se abre con la tecla Super, con Super + Mayús + Espacio o con la burbuja de la franja. Reúne escenas guardadas, apps, búsqueda y un panel del sistema.
- **Escenas guardadas**: guarda tus ventanas tal como están o arma una escena arrastrando apps, y ábrela de una vez.
- **Panel del sistema**: ajustes rápidos, volumen, brillo, perfil de energía, Modo activo, la semana, notificaciones y energía.
- **Notificaciones en la burbuja**: la burbuja salta, muestra el icono de la app y una línea de texto, y lleva el contador de no leídas. Al pasar el ratón sale la lista de las últimas. Con la burbuja fuera de la vista, avisa una isla flotante arriba al centro.
- **Micrófono, cámara y pantalla**: el borde de la burbuja se ilumina mientras se usan, y puedes ver qué app los usa, ir a ella o cortar.

## Requisitos

GNOME Shell 48.

## Instalación

Con el paquete `.zip`:

```sh
gnome-extensions install --force Joao-4.1.shell-extension.zip
```

Desde este repositorio:

```sh
./install.sh
```

Después cierra la sesión y vuelve a entrar (en X11 basta con Alt + F2 y `r`), y actívala:

```sh
gnome-extensions enable joao@frankm
```

## Antes de activarla

João cambia cómo funciona el escritorio: oculta la barra superior, usa la tecla Super para su lanzador y toma algunos atajos de GNOME, que devuelve al apagarla. La barra, los atajos y las notificaciones se ajustan en sus preferencias.

Si Firefox solo tiene permiso de notificar para WhatsApp Web, puedes activar en Preferencias → Isla de notificaciones la opción de mostrar esos avisos como WhatsApp. Firefox no dice de qué página viene cada aviso, así que todos saldrán con ese nombre.

## Licencia

GPL-2.0-or-later. Ver [LICENSE](LICENSE).
